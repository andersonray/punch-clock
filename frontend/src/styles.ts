import { css } from "lit";

/**
 * Theme tokens, mapped from Home Assistant's theme variables so the panel follows
 * the user's light/dark theme. Defined once on the panel root and inherited.
 */
export const themeTokens = css`
  :host {
    --pc-primary: var(--primary-color, #03a9f4);
    --pc-on-primary: var(--text-primary-color, #fff);
    --pc-text: var(--primary-text-color, #212121);
    --pc-text-2: var(--secondary-text-color, #727272);
    --pc-bg: var(--primary-background-color, #fafafa);
    --pc-card: var(--card-background-color, var(--ha-card-background, #fff));
    --pc-bg-2: var(--secondary-background-color, #f0f0f0);
    --pc-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
    --pc-minor: color-mix(in srgb, var(--pc-divider) 45%, transparent);
    --pc-error: var(--error-color, #db4437);
    --pc-warning: var(--warning-color, #ffa600);
    --pc-success: var(--success-color, #43a047);
    --pc-disabled: var(--disabled-text-color, #bdbdbd);
    --pc-header-bg: var(--app-header-background-color, var(--pc-primary));
    --pc-header-text: var(--app-header-text-color, var(--pc-on-primary));
    --pc-radius: 12px;
    --pc-radius-sm: 8px;
  }
`;

/** Buttons, inputs and small shared bits used by every component. */
export const controls = css`
  :host {
    color: var(--pc-text);
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 18px;
    border: 1px solid var(--pc-divider);
    background: transparent;
    color: var(--pc-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover {
    background: color-mix(in srgb, var(--pc-text) 6%, transparent);
  }
  .btn.primary {
    background: var(--pc-primary);
    border-color: var(--pc-primary);
    color: var(--pc-on-primary);
  }
  .btn.primary:hover {
    background: color-mix(in srgb, var(--pc-primary) 88%, black);
  }
  .btn.danger {
    color: var(--pc-error);
    border-color: color-mix(in srgb, var(--pc-error) 40%, transparent);
  }
  .btn.text {
    border-color: transparent;
    color: var(--pc-primary);
    padding: 0 8px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .icon-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .icon-btn.small {
    width: 30px;
    height: 30px;
  }
  input[type="text"],
  input[type="number"],
  input[type="time"],
  input:not([type]),
  select,
  textarea {
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--pc-divider);
    border-radius: var(--pc-radius-sm);
    background: var(--pc-card);
    min-width: 0;
  }
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--pc-primary);
    outline-offset: 1px;
  }
  textarea {
    resize: vertical;
    font-family: var(--code-font-family, ui-monospace, monospace);
    font-size: 0.9em;
  }
  label {
    color: var(--pc-text-2);
    font-size: 0.85em;
  }
  .muted {
    color: var(--pc-text-2);
  }
  .error-text {
    color: var(--pc-error);
    font-size: 0.9em;
  }
  .warning-text {
    color: var(--pc-warning);
    font-size: 0.9em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.8em;
    white-space: nowrap;
    background: var(--pc-bg-2);
    color: var(--pc-text-2);
  }
  .chip.true {
    background: color-mix(in srgb, var(--pc-success) 18%, transparent);
    color: var(--pc-success);
  }
  .chip.false {
    background: color-mix(in srgb, var(--pc-error) 15%, transparent);
    color: var(--pc-error);
  }
  .switch {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex: none;
  }
  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch span {
    position: absolute;
    inset: 0;
    border-radius: 10px;
    background: var(--pc-disabled);
    cursor: pointer;
    transition: background 0.15s;
  }
  .switch span::before {
    content: "";
    position: absolute;
    width: 16px;
    height: 16px;
    left: 2px;
    top: 2px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  .switch input:checked + span {
    background: var(--pc-primary);
  }
  .switch input:checked + span::before {
    transform: translateX(16px);
  }
  .switch input:focus-visible + span {
    outline: 2px solid var(--pc-primary);
    outline-offset: 2px;
  }
`;
