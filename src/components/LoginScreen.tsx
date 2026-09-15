import { useStorage } from "../context/StorageContext";
import { getRuntimeSettings } from "../lib/buildConfig";
import { BrandMark } from "./BrandMark";

export function LoginScreen() {
  const { loginWithOidc, error, status } = useStorage();
  // The product always uses MAS/OIDC; password authentication is never
  // exposed by this client.
  const busy = status === "connecting";

  async function handleOidc() {
    await loginWithOidc();
  }

  const oidcLabel = `Log in with ${new URL(getRuntimeSettings().homeserver).host}`;

  return (
    <div className="centered">
      <div className="panel">
        <div className="login-brand">
          <BrandMark />
          <h1>TeleCrypt.io Storage</h1>
        </div>
        {error && (
          <p className="error" data-testid="auth-error">
            {error}
          </p>
        )}
        <button type="button" disabled={busy} onClick={handleOidc} data-testid="oidc-login">
          {busy ? "Working…" : oidcLabel}
        </button>
      </div>
    </div>
  );
}
