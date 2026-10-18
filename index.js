/**
 * Host half of the account-balance-pill bundle.
 *
 * The balance is read entirely by the Client half through the shipped account
 * Remote (`remote.account.getBalance`), the same call the Settings > Account
 * panel uses. This half therefore registers no credential, network client,
 * tool or session record of its own; it exists so the bundle has a valid Host
 * entry point and its Client half can be composed.
 */
export function apply() {}
