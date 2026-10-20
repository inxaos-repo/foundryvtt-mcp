/**
 * Game-system adapters for `system_roll`.
 *
 * A headless socket client cannot call a system's own roll API: those methods
 * live on client-side document classes that only exist in a browser session.
 * Adapters instead derive the roll from actor data and return a formula plus a
 * function that turns the result into a verdict. Register an adapter per
 * system id (the `id` field of the system manifest).
 */

export interface SystemCheckOptions {
  /** Sub-type of the check, e.g. a save category or ability abbreviation. */
  key?: string;
  /** Number the check is made against when the actor sheet does not hold it (e.g. target armour class). */
  target?: number;
  /** Adapter-defined variant, e.g. melee or missile for attacks. */
  variant?: string;
  /** Flat modifier added to the roll. */
  modifier?: number;
}

export interface SystemCheck {
  formula: string;
  label: string;
  /** Verdict for an evaluated roll; `natural` is the first die's face value. */
  evaluate: (total: number, natural: number) => string;
}

export interface SystemRollAdapter {
  /** Foundry system id this adapter handles. */
  readonly systemId: string;
  /** Check kinds accepted by {@link buildCheck}, with a one-line hint each. */
  readonly kinds: Readonly<Record<string, string>>;
  /** Default initiative formula for encounters in this system. */
  readonly initiativeFormula?: string;
  buildCheck(
    actor: Record<string, unknown>,
    kind: string,
    options: SystemCheckOptions,
  ): SystemCheck;
}
