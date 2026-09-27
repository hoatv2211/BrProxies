import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TotpCode = { code: string; expiresAt: number };

export function TotpAuthenticator() {
  const [secret, setSecret] = useState("");
  const [visible, setVisible] = useState(false);
  const [activeSecret, setActiveSecret] = useState("");
  const [result, setResult] = useState<TotpCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useRef(0);

  // A new input, Clear, or unmount invalidates all outstanding responses.
  function reset(value: string) {
    revision.current += 1;
    setSecret(value);
    setActiveSecret("");
    setResult(null);
    setBusy(false);
    setError("");
    setNotice("");
    if (!value) setVisible(false);
  }

  useEffect(() => {
    if (!activeSecret) return;
    const current = ++revision.current;
    let pending = false;
    let expiresAt = 0;
    async function tick() {
      const time = Date.now();
      setNow(time);
      if (pending || time < expiresAt * 1000) return;
      pending = true;
      setResult(null);
      setNotice("");
      setBusy(true);
      try {
        const next = await invoke<TotpCode>("account_keeper_generate_totp", { secret: activeSecret });
        if (current !== revision.current) return;
        if (!/^\d{6}$/.test(next.code) || !Number.isFinite(next.expiresAt)) {
          throw new Error("Invalid code");
        }
        // IPC may straddle the time-step boundary. Retry without displaying the stale code.
        if (next.expiresAt * 1000 <= Date.now()) return;
        expiresAt = next.expiresAt;
        setNow(Date.now());
        setResult(next);
      } catch {
        if (current !== revision.current) return;
        setError("Could not generate a code. Check the Base32 secret and your system clock.");
        setActiveSecret("");
      } finally {
        pending = false;
        if (current === revision.current) setBusy(false);
      }
    }
    void tick();
    const timer = window.setInterval(() => void tick(), 250);
    const refresh = () => void tick();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      revision.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeSecret]);

  const remaining = result ? Math.max(0, Math.ceil((result.expiresAt * 1000 - now) / 1000)) : 0;
  async function copy() {
    if (!result || Date.now() >= result.expiresAt * 1000) return;
    const current = revision.current;
    try {
      await invoke("clipboard_write", { text: result.code });
      if (current === revision.current) setNotice("Code copied.");
    } catch {
      if (current === revision.current) setError("Could not copy the code. Please try again.");
    }
  }

  return (
    <section className="account-keeper__panel account-keeper__totp" aria-labelledby="account-keeper-totp-title">
      <div className="account-keeper__panel-head">
        <div><span className="account-keeper__step" aria-hidden="true">2FA</span><h2 id="account-keeper-totp-title">2FA Authenticator</h2></div>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!secret.trim() || busy || activeSecret) return;
        setError("");
        setNotice("");
        setActiveSecret(secret.trim());
      }}>
        <div className="account-keeper__field">
          <label htmlFor="account-keeper-totp-secret">2FA secret</label>
          <input id="account-keeper-totp-secret" type={visible ? "text" : "password"} value={secret}
            onChange={(event) => reset(event.target.value)} maxLength={1024} autoComplete="off"
            spellCheck={false} autoCapitalize="none" placeholder="Paste Base32 secret" aria-describedby="account-keeper-totp-privacy" />
          <button type="button" className="btn-sm account-keeper__totp-reveal" aria-pressed={visible}
            onClick={() => setVisible(!visible)}>{visible ? "Hide secret" : "Show secret"}</button>
        </div>
        <div className="account-keeper__totp-actions">
          <button type="submit" className="btn-primary" disabled={!secret.trim() || busy || !!activeSecret}>{busy ? "Generating…" : "Get code"}</button>
          <button type="button" className="btn-ghost" onClick={() => reset("")}>Clear</button>
        </div>
      </form>
      <div className="account-keeper__totp-result">
        <span className="account-keeper__totp-code" aria-label="2FA code">{remaining > 0 ? result?.code : "------"}</span>
        <span className="account-keeper__totp-expiry">{remaining > 0 ? `Expires in ${remaining}s` : "6 digits · refreshes every 30s"}</span>
        <button type="button" className="btn-sm" disabled={!result || remaining === 0} onClick={() => void copy()}>Copy code</button>
      </div>
      {error && <p className="account-keeper__message account-keeper__message--error" role="alert">{error}</p>}
      {notice && <p role="status" className="account-keeper__totp-hint">{notice}</p>}
      <p id="account-keeper-totp-privacy" className="account-keeper__totp-hint">Generated locally. Secret is not saved or sent online. Keep your system clock accurate.</p>
    </section>
  );
}
