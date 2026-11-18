"use client";

import { useEffect, useRef } from "react";

/**
 * A hidden `timeZone` field holding the browser's IANA time zone, filled after hydration (empty in the server HTML,
 * so there is no mismatch; absent in effect without JavaScript). Registration stores it on the new account and a
 * sign-in stores it on an account that has none yet; the server validates it and ignores anything invalid.
 */
export function BrowserTimeZoneInput() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      if (ref.current) ref.current.value = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      // No Intl time-zone support: leave it empty.
    }
  }, []);
  return <input ref={ref} type="hidden" name="timeZone" defaultValue="" />;
}
