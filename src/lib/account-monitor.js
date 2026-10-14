/** Observe account changes without changing credentials or restarting a turn. */
export function monitorAccount({ initialEmail, detect, onChange, intervalMs = 10_000 }) {
  let lastEmail = initialEmail;
  let stopped = false;
  let timer;
  let pending = Promise.resolve();
  const poll = async () => {
    try {
      const account = await detect();
      const email = account?.email || null;
      if (!stopped && email && email !== lastEmail) {
        await onChange(email, lastEmail);
        lastEmail = email;
      }
    } catch { /* Missing observations are not evidence of an account switch. */ }
    if (!stopped) timer = setTimeout(() => { pending = poll(); }, intervalMs);
  };
  timer = setTimeout(() => { pending = poll(); }, intervalMs);
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
