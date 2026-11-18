"use client";

import { useEffect, useState } from "react";

/**
 * A hidden `timeZone` field holding the browser's IANA time zone, filled after hydration (empty in the server HTML,
 * so there is no mismatch; absent in effect without JavaScript). Registration stores it on the new account and a
 * sign-in stores it on an account that has none yet; the server validates it and ignores anything invalid.
 *
 * The zone lives in state and goes in as `defaultValue`: React writes an uncontrolled input's `defaultValue` again on
 * every re-render, so a zone written straight into the DOM was wiped by the re-render after a refused submit.
 */
export function BrowserTimeZoneInput() {
  const [zone, setZone] = useState("");
  useEffect(() => {
    let browserZone = "";
    try {
      browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      // No Intl time-zone support: leave it empty.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's zone exists only after hydration
    setZone(browserZone);
  }, []);
  return <input type="hidden" name="timeZone" defaultValue={zone} />;
}
