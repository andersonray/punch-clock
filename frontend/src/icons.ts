import { html, type TemplateResult } from "lit";

export {
  mdiAlertCircleOutline,
  mdiAlertOutline,
  mdiCalendarClock,
  mdiCallSplit,
  mdiCheck,
  mdiClockOutline,
  mdiClose,
  mdiCog,
  mdiContentCopy,
  mdiDelete,
  mdiDotsVertical,
  mdiEyedropper,
  mdiFilterOff,
  mdiFilterVariant,
  mdiFlash,
  mdiKeyboardOutline,
  mdiMenu,
  mdiMenuDown,
  mdiPlus,
  mdiRefresh,
  mdiTimerSandEmpty,
} from "@mdi/js";

export function icon(path: string, size = 20): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true">
    <path fill="currentColor" d=${path}></path>
  </svg>`;
}
