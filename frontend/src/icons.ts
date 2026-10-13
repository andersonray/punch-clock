import { html, type TemplateResult } from "lit";

export {
  mdiAlertCircleOutline,
  mdiAlertOutline,
  mdiCalendarClock,
  mdiCheck,
  mdiClose,
  mdiCog,
  mdiContentCopy,
  mdiDelete,
  mdiDotsVertical,
  mdiEyedropper,
  mdiFilterVariant,
  mdiFlash,
  mdiMenu,
  mdiPlus,
  mdiRefresh,
  mdiTimerSandEmpty,
} from "@mdi/js";

export function icon(path: string, size = 20): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true">
    <path fill="currentColor" d=${path}></path>
  </svg>`;
}
