"""The scheduler engine: evaluates the schedule and writes desired values.

See docs/semantics.md for the rules. All decisions are made by the pure code in
``logic/``; this module wires it to Home Assistant (timers, state events,
service calls) and keeps runtime bookkeeping (pending writes, write budget,
errors).
"""

import asyncio
import logging
from collections import deque
from datetime import datetime, tzinfo
from typing import Any

from homeassistant.const import EVENT_CORE_CONFIG_UPDATE
from homeassistant.core import (
    CALLBACK_TYPE,
    Context,
    Event,
    EventStateChangedData,
    HomeAssistant,
    State,
    callback,
)
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_point_in_utc_time,
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util, slugify

from .const import (
    DOMAIN,
    EVENT_APPLIED,
    EVENT_LOGBOOK_ENTRY,
    EVENT_PROBLEM,
    ISSUE_WRITE_BUDGET,
    MAX_ERRORS,
    MEDIA_PLAYER_ON_TIMEOUT,
    SAFETY_INTERVAL,
    SERVICE_TIMEOUT,
    SIGNAL_CONFIG_UPDATED,
    SIGNAL_STATUS_UPDATED,
    WRITE_BUDGET,
    WRITE_BUDGET_WINDOW,
    WRITE_SUPPRESS_SECONDS,
)
from .logic import actions
from .logic.actions import ServiceCall
from .logic.conditions import referenced
from .logic.describe import (
    TITLE,
    entity_ids,
    problem_message,
    service_message,
    source_data,
    write_message,
)
from .logic.model import Config
from .logic.resolver import SERVICE_PREFIX, SERVICE_SETTING, Key, Resolution, Source, resolve
from .logic.state import SPECIAL_STATES, StateView
from .logic.timemath import boundaries, next_boundary, week_minute
from .logic.transitions import Mode, plan_writes
from .logic.units import convert_settings, convert_value
from .store import PunchClockStore

_LOGGER = logging.getLogger(__name__)
_MISSING = object()


class PunchClockEngine:
    """Evaluates the schedule whenever something relevant changes and applies it."""

    def __init__(self, hass: HomeAssistant, store: PunchClockStore) -> None:
        self.hass = hass
        self.store = store
        self.resolution = Resolution()
        self.next_boundary: datetime | None = None
        self.evaluated_at: datetime | None = None
        self._started = False
        self._was_enabled = store.config.settings.enabled
        self._debouncer: Debouncer[None] = Debouncer(
            hass,
            _LOGGER,
            cooldown=store.config.settings.debounce_seconds,
            immediate=True,
            function=self._on_debounced,
        )
        self._unsubs: list[CALLBACK_TYPE] = []
        self._unsub_timer: CALLBACK_TYPE | None = None
        self._unsub_states: CALLBACK_TYPE | None = None
        self._watch: dict[str, set[str | None]] = {}
        self._tracked: frozenset[str] = frozenset()
        self._pending: dict[str, dict[str, Any]] = {}
        self._writes: dict[str, deque[float]] = {}
        self._suppressed: dict[str, float] = {}
        self._errors: deque[dict[str, Any]] = deque(maxlen=MAX_ERRORS)

    # ------------------------------------------------------------------ lifecycle

    async def async_start(self, _hass: HomeAssistant | None = None) -> None:
        """Start scheduling. Called once Home Assistant has started."""
        if self._started:
            return
        self._started = True
        self._unsubs.extend(
            [
                async_dispatcher_connect(self.hass, SIGNAL_CONFIG_UPDATED, self._on_config_updated),
                async_track_time_interval(
                    self.hass, self._on_safety_tick, SAFETY_INTERVAL, cancel_on_shutdown=True
                ),
                self.hass.bus.async_listen(EVENT_CORE_CONFIG_UPDATE, self._on_core_config_updated),
            ]
        )
        self.evaluate(Mode.STARTUP, "startup")

    @callback
    def async_stop(self) -> None:
        self._started = False
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._unsub_timer is not None:
            self._unsub_timer()
            self._unsub_timer = None
        if self._unsub_states is not None:
            self._unsub_states()
            self._unsub_states = None
        self._tracked = frozenset()
        self._debouncer.async_shutdown()

    @property
    def started(self) -> bool:
        return self._started

    # ------------------------------------------------------------------ evaluation

    @callback
    def evaluate(self, mode: Mode, reason: str) -> None:
        """Resolve the schedule now and write whatever transitioned."""
        if not self._started:
            return
        config = self.store.config
        now = dt_util.utcnow()
        tz = dt_util.get_default_time_zone()
        self.resolution = resolve(config, week_minute(now.astimezone(tz)), self.lookup)
        self.evaluated_at = now
        self._arm_timer(config, now, tz)

        enabled = config.settings.enabled
        if enabled:
            if not self._was_enabled and mode is Mode.NORMAL:
                mode = Mode.REENABLE
                reason = "enabled"
            desired = self.resolution.values()
            self._prune_pending(desired)
            writes = plan_writes(desired, self.store.last_desired, self._matches, mode)
            if writes:
                _LOGGER.debug("Evaluation (%s, %s) writes %s", reason, mode, writes)
                self._apply(writes, reason)
            self.store.async_set_last_desired(desired)
        self._was_enabled = enabled
        self._update_tracking()
        async_dispatcher_send(self.hass, SIGNAL_STATUS_UPDATED)

    @callback
    def _arm_timer(self, config: Config, now: datetime, tz: tzinfo) -> None:
        enabled_tabs = {t.id for t in config.tabs if t.enabled}
        bounds = boundaries(b for b in config.blocks if b.tab_id in enabled_tabs)
        target = next_boundary(now, bounds, tz)
        if target == self.next_boundary and self._unsub_timer is not None:
            return
        if self._unsub_timer is not None:
            self._unsub_timer()
            self._unsub_timer = None
        self.next_boundary = target
        if target is not None:
            self._unsub_timer = async_track_point_in_utc_time(self.hass, self._on_timer, target)

    @callback
    def lookup(self, entity_id: str) -> StateView | None:
        state = self.hass.states.get(entity_id)
        return None if state is None else StateView(state.state, state.attributes)

    @callback
    def _matches(self, key: Key, value: Any) -> bool:
        if key[0].startswith(SERVICE_PREFIX):
            return False
        value = convert_value(key[0], key[1], value, *self._units())
        return actions.matches(key[0], key[1], value, self.lookup(key[0]))

    @callback
    def _units(self) -> tuple[str, str]:
        """(unit the schedule is written in, Home Assistant's unit) for temperatures."""
        return self.store.config.settings.temperature_unit, self.hass.config.units.temperature_unit

    # ------------------------------------------------------------------ triggers

    @callback
    def _on_timer(self, _now: datetime) -> None:
        self._unsub_timer = None
        self.evaluate(Mode.NORMAL, "schedule")

    @callback
    def _on_safety_tick(self, _now: datetime) -> None:
        self.evaluate(Mode.NORMAL, "periodic")

    @callback
    def _on_core_config_updated(self, _event: Event) -> None:
        self.evaluate(Mode.NORMAL, "core_config")

    @callback
    def _on_config_updated(self) -> None:
        self._debouncer.cooldown = self.store.config.settings.debounce_seconds
        self.evaluate(Mode.NORMAL, "config")

    @callback
    def _on_debounced(self) -> None:
        self.evaluate(Mode.NORMAL, "condition")

    @callback
    def _update_tracking(self) -> None:
        if not self._started:
            return
        config = self.store.config
        watch: dict[str, set[str | None]] = {}
        for group in [t.conditions for t in config.tabs] + [b.conditions for b in config.blocks]:
            for entity_id, attributes in referenced(group).items():
                watch.setdefault(entity_id, set()).update(attributes)
        self._watch = watch
        tracked = frozenset(watch) | frozenset(self._pending)
        if tracked == self._tracked:
            return
        if self._unsub_states is not None:
            self._unsub_states()
            self._unsub_states = None
        self._tracked = tracked
        if tracked:
            self._unsub_states = async_track_state_change_event(
                self.hass, tracked, self._on_state_changed
            )

    @callback
    def _on_state_changed(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        old, new = event.data["old_state"], event.data["new_state"]
        if entity_id in self._pending and new is not None and new.state not in SPECIAL_STATES:
            self._drain_pending(entity_id)
        attributes = self._watch.get(entity_id)
        if attributes is None:
            return
        if old is None or new is None or _relevant_change(attributes, old, new):
            self._debouncer.async_schedule_call()

    # ------------------------------------------------------------------ writing

    @callback
    def _apply(self, writes: dict[str, dict[str, Any]], reason: str) -> None:
        for target, settings in writes.items():
            if target.startswith(SERVICE_PREFIX):
                value = settings[SERVICE_SETTING]
                if self._spend_budget(target):
                    call = actions.plan_service(value["service"], value["target"], value["data"])
                    self._launch(target, [call], reason, settings)
                continue
            state = self.lookup(target)
            if state is None or not state.available:
                self._pending.setdefault(target, {}).update(settings)
                continue
            self._write_entity(target, settings, state, reason)

    @callback
    def _write_entity(
        self, entity_id: str, settings: dict[str, Any], state: StateView, reason: str
    ) -> None:
        result = actions.plan(
            entity_id, convert_settings(entity_id, settings, *self._units()), state
        )
        for key, why in result.skipped:
            self._record(entity_id, f"{key} skipped: {why}")
        if result.calls and self._spend_budget(entity_id):
            sent = {k: v for k, v in settings.items() if k not in result.unsent}
            self._launch(entity_id, result.calls, reason, sent)

    @callback
    def _launch(
        self, target: str, calls: list[ServiceCall], reason: str, settings: dict[str, Any]
    ) -> None:
        """Record a write in Activity and announce it, then make its service calls.

        Each write gets a context of its own, shared by its Activity entry, its event
        and its service calls. The entry comes first, so Activity doesn't credit the
        resulting state changes to the bare service call.
        """
        context = Context()
        data = self._applied_data(target, settings, reason)
        if data["service"]:
            targets = [self._name(i) for i in entity_ids(data["target"])]
            message = service_message(data["service"], targets, data["sources"], reason)
            self._log(TITLE, message, None, context)
        else:
            unit = data["temperature_unit"]
            message = write_message(target, settings, unit, data["sources"], reason)
            self._log(data["name"] or target, message, target, context)
        self.hass.bus.async_fire(EVENT_APPLIED, data, context=context)
        self.hass.async_create_task(
            self._async_execute(target, calls, context), f"{DOMAIN} apply {target}"
        )

    @callback
    def _log(
        self, name: str, message: str, entity_id: str | None, context: Context | None = None
    ) -> None:
        """Add an entry to Home Assistant's Activity view (the logbook).

        An entry with an ``entity_id`` also shows in that entity's own Activity, which
        HA only allows for logbook entries (not for an integration's own events).
        """
        data = {"name": name, "message": message, "domain": DOMAIN}
        if entity_id is not None:
            data["entity_id"] = entity_id
        self.hass.bus.async_fire(EVENT_LOGBOOK_ENTRY, data, context=context)

    @callback
    def _name(self, entity_id: str) -> str:
        state = self.hass.states.get(entity_id)
        return state.name if state is not None else entity_id

    @callback
    def _applied_data(self, target: str, settings: dict[str, Any], reason: str) -> dict[str, Any]:
        """The punch_clock_applied event data; see docs/semantics.md."""
        config = self.store.config
        by_source: dict[Source, list[str]] = {}
        for key in settings:
            desired = self.resolution.desired.get((target, key))
            if desired is not None:
                by_source.setdefault(desired.source, []).append(key)
        data = self._target_data(target)
        if target.startswith(SERVICE_PREFIX):
            value = settings[SERVICE_SETTING]
            data.update(target=value["target"], service_data=value["data"])
        else:
            data.update(settings=settings, temperature_unit=config.settings.temperature_unit)
        data["sources"] = [source_data(config, s, keys) for s, keys in by_source.items()]
        data["reason"] = reason
        return data

    @callback
    def _target_data(self, target: str) -> dict[str, Any]:
        if target.startswith(SERVICE_PREFIX):
            service = target.removeprefix(SERVICE_PREFIX).split("|", 1)[0]
            return {"entity_id": None, "name": None, "service": service}
        state = self.hass.states.get(target)
        return {"entity_id": target, "name": state.name if state else None, "service": None}

    async def _async_execute(self, target: str, calls: list[ServiceCall], context: Context) -> None:
        failed = False
        for index, call in enumerate(calls):
            try:
                async with asyncio.timeout(SERVICE_TIMEOUT):
                    await self.hass.services.async_call(
                        call.domain,
                        call.service,
                        dict(call.data),
                        blocking=True,
                        context=context,
                        target=dict(call.target),
                    )
            except Exception as err:
                failed = True
                detail = str(err) or type(err).__name__
                self._record(target, f"{call.domain}.{call.service} failed: {detail}")
                continue
            if (call.domain, call.service) == ("media_player", "turn_on") and index < len(
                calls
            ) - 1:
                await self._async_wait_until_on(target)
        if failed:
            async_dispatcher_send(self.hass, SIGNAL_STATUS_UPDATED)

    async def _async_wait_until_on(self, entity_id: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + MEDIA_PLAYER_ON_TIMEOUT
        while loop.time() < deadline:
            state = self.hass.states.get(entity_id)
            if state is not None and state.state not in {"off", "standby", *SPECIAL_STATES}:
                return
            await asyncio.sleep(0.5)

    @callback
    def _prune_pending(self, desired: dict[Key, Any]) -> None:
        """Forget pending writes that are no longer desired."""
        for entity_id in list(self._pending):
            settings = {
                k: v
                for k, v in self._pending[entity_id].items()
                if desired.get((entity_id, k), _MISSING) == v
            }
            if settings:
                self._pending[entity_id] = settings
            else:
                del self._pending[entity_id]

    @callback
    def _drain_pending(self, entity_id: str) -> None:
        """An entity with pending writes became available: write what's still desired."""
        settings = self._pending.pop(entity_id, None)
        if not settings or not self.store.config.settings.enabled:
            return
        desired = self.resolution.values()
        still = {k: v for k, v in settings.items() if desired.get((entity_id, k), _MISSING) == v}
        state = self.lookup(entity_id)
        if still and state is not None and state.available:
            todo = {k: v for k, v in still.items() if not self._matches((entity_id, k), v)}
            if todo:
                self._write_entity(entity_id, todo, state, "available")
        self._update_tracking()
        async_dispatcher_send(self.hass, SIGNAL_STATUS_UPDATED)

    @callback
    def _spend_budget(self, target: str) -> bool:
        """Count a write; refuse it if the target was written too often recently."""
        now = dt_util.utcnow().timestamp()
        issue_id = f"{ISSUE_WRITE_BUDGET}_{slugify(target)}"
        until = self._suppressed.get(target)
        if until is not None:
            if now < until:
                return False
            del self._suppressed[target]
            ir.async_delete_issue(self.hass, DOMAIN, issue_id)
        writes = self._writes.setdefault(target, deque())
        while writes and writes[0] <= now - WRITE_BUDGET_WINDOW:
            writes.popleft()
        if len(writes) >= WRITE_BUDGET:
            self._suppressed[target] = now + WRITE_SUPPRESS_SECONDS
            writes.clear()
            self._record(
                target,
                f"more than {WRITE_BUDGET} writes in {WRITE_BUDGET_WINDOW / 60:.0f} minutes; "
                f"writes paused for {WRITE_SUPPRESS_SECONDS / 60:.0f} minutes",
            )
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                issue_id,
                is_fixable=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key=ISSUE_WRITE_BUDGET,
                translation_placeholders={"target": target},
            )
            return False
        writes.append(now)
        return True

    @callback
    def _record(self, target: str, message: str) -> None:
        _LOGGER.warning("%s: %s", target, message)
        self._errors.appendleft(
            {"time": dt_util.utcnow().isoformat(), "entity_id": target, "message": message}
        )
        problem = {**self._target_data(target), "message": message}
        if problem["service"]:
            self._log(TITLE, problem_message(message, problem["service"]), None)
        else:
            self._log(problem["name"] or target, problem_message(message), target)
        self.hass.bus.async_fire(EVENT_PROBLEM, problem)

    # ------------------------------------------------------------------ status

    @callback
    def status(self) -> dict[str, Any]:
        """A JSON-serializable snapshot for the panel."""
        config = self.store.config
        now = dt_util.utcnow().timestamp()
        return {
            "enabled": config.settings.enabled,
            "started": self._started,
            "evaluated_at": self.evaluated_at.isoformat() if self.evaluated_at else None,
            "next_boundary": self.next_boundary.isoformat() if self.next_boundary else None,
            "tabs": {
                tab_id: {
                    "enabled": s.enabled,
                    "conditions_met": s.conditions_met,
                    "active": s.active,
                }
                for tab_id, s in self.resolution.tabs.items()
            },
            "blocks": {
                block_id: {
                    "in_window": s.in_window,
                    "conditions_met": s.conditions_met,
                    "active": s.active,
                }
                for block_id, s in self.resolution.blocks.items()
            },
            "desired": [
                {
                    "entity_id": key[0],
                    "key": key[1],
                    "value": d.value,
                    "source": {
                        "kind": d.source.kind,
                        "tab_id": d.source.tab_id,
                        "block_id": d.source.block_id,
                    },
                }
                for key, d in self.resolution.desired.items()
            ],
            "pending": sorted(self._pending),
            "suppressed": [
                {"entity_id": target, "until": dt_util.utc_from_timestamp(until).isoformat()}
                for target, until in self._suppressed.items()
                if until > now
            ],
            "errors": list(self._errors),
        }


def _relevant_change(attributes: set[str | None], old: State, new: State) -> bool:
    """True if the state or a referenced attribute changed."""
    if None in attributes and old.state != new.state:
        return True
    return any(old.attributes.get(a) != new.attributes.get(a) for a in attributes if a is not None)
