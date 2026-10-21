import type { Store } from "../../src/domain/model";
import { defaultSettings } from "../../src/domain/settings";
import { emptyStore } from "../../src/domain/selectors";

/** Business-rule fixtures start after onboarding; setup itself has separate workflow coverage. */
export function configuredStore(): Store {
  return {
    ...emptyStore(),
    settings: { ...defaultSettings(), setupCompleted: true },
  };
}
