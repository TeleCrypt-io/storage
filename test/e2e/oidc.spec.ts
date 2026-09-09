import { test } from "./fixtures";
import { registerE2eUser } from "./testUsers";
import { createVault, loginViaUI } from "./uiHelpers";

// Real authorization-code + PKCE flow against the local disposable MAS: the UI redirects to MAS's
// actual login + consent pages (driven here for real, no mocks), MAS
// redirects back with ?code&state, the UI exchanges it and lands logged in.
// Mirrors the CLI's device-code flow tested in test/functional/oidc.test.ts,
// but this is the one PKCE test that actually exercises the browser
// redirect round-trip, which the CLI's flow never does.
test("OIDC/MAS login: authorization-code + PKCE round trip through the real MAS login UI", async ({
  page,
}) => {
  const user = await registerE2eUser("e2e_oidc");

  await loginViaUI(page, user);

  // Prove the OIDC-sourced token is a genuinely usable, fully-functional
  // storage session, not just "whoami succeeded".
  await createVault(page, "OIDC Vault");
});
