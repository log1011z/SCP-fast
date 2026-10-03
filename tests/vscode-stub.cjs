// Only the password-dialog surface is simulated. SSH, scp and askpass are real.
let accepted = 0;
function dialog() {
  let accept, hide;
  return {
    value: 'scp-fast-smoke-password', selectedItems: [],
    onDidAccept(fn) { accept = fn; }, onDidHide(fn) { hide = fn; },
    show() { if (/Verification code/i.test(this.prompt || '')) this.value = '123456'; accepted++; setTimeout(() => accept(), 10); },
    hide() { hide?.(); }, dispose() {}
  };
}
module.exports = { window: { createInputBox: dialog, createQuickPick: dialog }, getAccepted: () => accepted };
