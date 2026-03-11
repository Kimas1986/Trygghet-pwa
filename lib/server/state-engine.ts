export type HomeState = "green" | "red" | "grey";
export type HomeMode = "home" | "away";

export type HomeLike = {
  home_id: string;
  state?: string | null;
  mode?: string | null;
  last_seen?: string | null;
  last_motion?: string | null;
  last_alert_window?: string | null;
  last_alert_time?: string | null;
};

export type IngestInput = {
  motion?: boolean;
  door_open?: boolean;
  heartbeat?: boolean;
  battery_low?: boolean;
  system_ok?: boolean;
  last_motion_at?: string | null;
  last_seen_at?: string | null;
};

export type ThresholdConfig = {
  greyThresholdMinutes: number;
  redThresholdHours: number;
};

export type IngestPatch = {
  last_seen?: string;
  last_motion?: string;
  mode?: HomeMode;
  mode_updated_at?: string;
  state?: HomeState;
  battery_low?: boolean;
  system_ok?: boolean;
};

export type EvaluatedHomeState = {
  nextState: HomeState;
  offlineTooLong: boolean;
  inactivityTooLong: boolean;
  isAway: boolean;
};

export type RedAlertDecision = {
  shouldCreate: boolean;
  windowKey: string;
  reason: string;
};

function parseDateOrNull(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(d: Date) {
  return d.toISOString();
}

export function normMode(v: unknown): HomeMode | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "home") return "home";
  if (s === "away") return "away";
  return null;
}

export function nowOsloHour(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  return Number(hh);
}

export function getRedWindowKey(now: Date, explicitWindow?: "12" | "18" | "23" | null) {
  if (explicitWindow === "12" || explicitWindow === "18" || explicitWindow === "23") {
    return `kl ${explicitWindow}`;
  }

  const hour = nowOsloHour(now);
  if (hour === 12 || hour === 18 || hour === 23) {
    return `kl ${hour}`;
  }

  return "red";
}

export function isRedWindowNow(now: Date) {
  const hour = nowOsloHour(now);
  return hour === 12 || hour === 18 || hour === 23;
}

/**
 * Viktig regel:
 * - motion kan sette huset grønt
 * - heartbeat skal IKKE automatisk sette huset grønt
 * - ack påvirker alerts, ikke home.state
 */
export function buildHomePatchFromIngest(input: IngestInput, now = new Date()): IngestPatch {
  const nowIso = iso(now);

  const patch: IngestPatch = {};

  if (typeof input.battery_low === "boolean") {
    patch.battery_low = input.battery_low;
  }

  if (typeof input.system_ok === "boolean") {
    patch.system_ok = input.system_ok;
  }

  const seenAt = parseDateOrNull(input.last_seen_at) ?? now;
  patch.last_seen = iso(seenAt);

  const motionAt = parseDateOrNull(input.last_motion_at);

  if (input.door_open === true) {
    patch.mode = "away";
    patch.mode_updated_at = nowIso;
  }

  if (input.motion === true || motionAt) {
    patch.last_motion = iso(motionAt ?? now);
    patch.last_seen = iso(motionAt ?? seenAt ?? now);
    patch.mode = "home";
    patch.mode_updated_at = nowIso;
    patch.state = "green";
  }

  if (input.heartbeat === true && input.motion !== true && !motionAt && input.door_open !== true) {
    // Bevisst: heartbeat oppdaterer kun last_seen
    // og setter IKKE state = green
  }

  return patch;
}

export function evaluateHomeState(
  home: HomeLike,
  cfg: ThresholdConfig,
  options?: {
    now?: Date;
    redEnabled?: boolean;
    doGrey?: boolean;
  }
): EvaluatedHomeState {
  const now = options?.now ?? new Date();
  const redEnabled = options?.redEnabled ?? false;
  const doGrey = options?.doGrey ?? true;

  const lastSeen = parseDateOrNull(home.last_seen);
  const lastMotion = parseDateOrNull(home.last_motion);
  const mode = normMode(home.mode);
  const isAway = mode === "away";

  const greyThresholdMs = cfg.greyThresholdMinutes * 60 * 1000;
  const redThresholdMs = cfg.redThresholdHours * 60 * 60 * 1000;

  const offlineTooLong =
    doGrey && (!lastSeen || now.getTime() - lastSeen.getTime() > greyThresholdMs);

  const inactivityTooLong =
    redEnabled &&
    !offlineTooLong &&
    !isAway &&
    (!lastMotion || now.getTime() - lastMotion.getTime() > redThresholdMs);

  let nextState: HomeState = "green";

  if (offlineTooLong) {
    nextState = "grey";
  } else if (inactivityTooLong) {
    nextState = "red";
  } else {
    nextState = "green";
  }

  return {
    nextState,
    offlineTooLong,
    inactivityTooLong,
    isAway,
  };
}

export function shouldCreateRedAlert(args: {
  home: HomeLike;
  now?: Date;
  explicitWindow?: "12" | "18" | "23" | null;
  redEnabled: boolean;
  nextState: HomeState;
}): RedAlertDecision {
  const now = args.now ?? new Date();
  const windowKey = getRedWindowKey(now, args.explicitWindow ?? null);

  if (!args.redEnabled) {
    return {
      shouldCreate: false,
      windowKey,
      reason: "red_disabled",
    };
  }

  if (args.nextState !== "red") {
    return {
      shouldCreate: false,
      windowKey,
      reason: "state_not_red",
    };
  }

  const lastAlertWindow = String(args.home.last_alert_window ?? "").trim();
  const lastAlertTime = parseDateOrNull(args.home.last_alert_time);

  const recentlyAlerted =
    lastAlertWindow === windowKey &&
    lastAlertTime &&
    now.getTime() - lastAlertTime.getTime() < 12 * 60 * 60 * 1000;

  if (recentlyAlerted) {
    return {
      shouldCreate: false,
      windowKey,
      reason: "already_alerted_this_window",
    };
  }

  return {
    shouldCreate: true,
    windowKey,
    reason: "create_red_alert",
  };
}

export function shouldEscalateOpenAlert(args: {
  triggered_at?: string | null;
  escalation_sent?: boolean | null;
  acknowledged?: boolean | null;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  now?: Date;
  smsEscalationMinutes: number;
}) {
  const now = args.now ?? new Date();

  if (args.escalation_sent) return false;
  if (args.acknowledged) return false;
  if (args.acknowledged_at) return false;
  if (args.resolved_at) return false;

  const trig = parseDateOrNull(args.triggered_at);
  if (!trig) return false;

  const ageMin = (now.getTime() - trig.getTime()) / (60 * 1000);
  return ageMin >= args.smsEscalationMinutes;
}

export function resolveHomePatchFromEvaluatedState(
  currentState: string | null | undefined,
  evaluated: EvaluatedHomeState
): Partial<HomeLike> {
  const cur = String(currentState ?? "").trim().toLowerCase();
  if (cur === evaluated.nextState) {
    return {};
  }

  return {
    state: evaluated.nextState,
  };
}