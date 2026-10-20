// Entry point: defines the panel and its components. Home Assistant can import an
// updated module without a page reload, so every definition is guarded.

import { PunchClockPanel } from "./panel/punch-clock-panel";
import { PcActionEditor } from "./components/pc-action-editor";
import { PcBlockEditor } from "./components/pc-block-editor";
import { PcCombobox } from "./components/pc-combobox";
import { PcConditionEditor } from "./components/pc-condition-editor";
import { PcConfirmDialog } from "./components/pc-confirm-dialog";
import { PcDialog } from "./components/pc-dialog";
import { PcDuplicateDialog } from "./components/pc-duplicate-dialog";
import { PcEntityFilter } from "./components/pc-entity-filter";
import { PcEntityPicker } from "./components/pc-entity-picker";
import { PcSettingsDialog } from "./components/pc-settings-dialog";
import { PcTabBar } from "./components/pc-tab-bar";
import { PcTabDialog } from "./components/pc-tab-dialog";
import { PcTimeInput } from "./components/pc-time-input";
import { PcTimePicker } from "./components/pc-time-picker";
import { PcWeekView } from "./components/pc-week-view";

const elements: [string, CustomElementConstructor][] = [
  ["pc-dialog", PcDialog],
  ["pc-confirm-dialog", PcConfirmDialog],
  ["pc-entity-picker", PcEntityPicker],
  ["pc-combobox", PcCombobox],
  ["pc-time-picker", PcTimePicker],
  ["pc-time-input", PcTimeInput],
  ["pc-action-editor", PcActionEditor],
  ["pc-condition-editor", PcConditionEditor],
  ["pc-week-view", PcWeekView],
  ["pc-entity-filter", PcEntityFilter],
  ["pc-tab-bar", PcTabBar],
  ["pc-block-editor", PcBlockEditor],
  ["pc-duplicate-dialog", PcDuplicateDialog],
  ["pc-tab-dialog", PcTabDialog],
  ["pc-settings-dialog", PcSettingsDialog],
  ["punch-clock-panel", PunchClockPanel],
];

for (const [name, ctor] of elements) {
  if (!customElements.get(name)) customElements.define(name, ctor);
}

declare global {
  interface HTMLElementTagNameMap {
    "punch-clock-panel": PunchClockPanel;
    "pc-block-editor": PcBlockEditor;
    "pc-confirm-dialog": PcConfirmDialog;
    "pc-week-view": PcWeekView;
    "pc-time-picker": PcTimePicker;
    "pc-time-input": PcTimeInput;
    "pc-action-editor": PcActionEditor;
    "pc-entity-picker": PcEntityPicker;
    "pc-tab-dialog": PcTabDialog;
    "pc-entity-filter": PcEntityFilter;
  }
}
