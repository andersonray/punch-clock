"""Find and rewrite entity references in a configuration."""

from dataclasses import replace
from typing import Any

from .model import Action, Block, Condition, Config, EntityAction, Group, ServiceAction, Tab


def entity_references(config: Config) -> set[str]:
    """Every entity ID used anywhere: conditions, actions, defaults and service targets."""
    found: set[str] = set()
    for tab in config.tabs:
        _group_refs(tab.conditions, found)
        found.update(a.entity_id for a in tab.defaults)
    for block in config.blocks:
        _group_refs(block.conditions, found)
        for action in block.actions:
            if isinstance(action, EntityAction):
                found.add(action.entity_id)
            else:
                found.update(action.target.get("entity_id", []))
    return found


def _group_refs(group: Group, found: set[str]) -> None:
    for item in group.items:
        if isinstance(item, Group):
            _group_refs(item, found)
        else:
            found.add(item.entity_id)


def rename_entity(config: Config, old: str, new: str) -> Config:
    """Return a copy of the config with every reference to ``old`` replaced by ``new``."""
    if old not in entity_references(config):
        return config

    def group(g: Group) -> Group:
        items: list[Condition | Group] = []
        for item in g.items:
            if isinstance(item, Group):
                items.append(group(item))
            elif item.entity_id == old:
                items.append(replace(item, entity_id=new))
            else:
                items.append(item)
        return replace(g, items=tuple(items))

    def entity_action(a: EntityAction) -> EntityAction:
        return replace(a, entity_id=new) if a.entity_id == old else a

    def action(a: Action) -> Action:
        if isinstance(a, EntityAction):
            return entity_action(a)
        return _service_action(a, old, new)

    def tab(t: Tab) -> Tab:
        return replace(
            t,
            conditions=group(t.conditions),
            defaults=tuple(entity_action(a) for a in t.defaults),
        )

    def block(b: Block) -> Block:
        return replace(
            b, conditions=group(b.conditions), actions=tuple(action(a) for a in b.actions)
        )

    return replace(
        config,
        tabs=tuple(tab(t) for t in config.tabs),
        blocks=tuple(block(b) for b in config.blocks),
    )


def _service_action(a: ServiceAction, old: str, new: str) -> ServiceAction:
    ids = a.target.get("entity_id")
    if not ids or old not in ids:
        return a
    target: dict[str, Any] = dict(a.target)
    target["entity_id"] = [new if e == old else e for e in ids]
    return replace(a, target=target)
