export type LoadProfileName =
  | 'smoke'
  | 'load'
  | 'stress'
  | 'spike'
  | 'soak'
  | 'rps';

export const loadProfileNames: LoadProfileName[] = [
  'smoke',
  'load',
  'stress',
  'spike',
  'soak',
  'rps',
];

export type VuSource = 'cli' | 'env' | 'profile default';

export interface K6Stage {
  duration: string;
  target: number;
}

export type K6ProfileOptions =
  | {
      vus: number;
      duration: string;
    }
  | {
      stages: K6Stage[];
    }
  | {
      scenarios: {
        default: {
          executor: 'constant-arrival-rate';
          rate: number;
          timeUnit: string;
          duration: string;
          preAllocatedVUs: number;
          maxVUs: number;
          gracefulStop: string;
        };
      };
    };

export interface LoadProfileDefinition {
  name: LoadProfileName;
  description: string;
  options: K6ProfileOptions;
}

/*
 * Conservative validation profiles for the shared
 * CalicoDesk environments (especially dev).
 *
 * These are not production traffic estimates.
 *
 * Observed on dev during earlier steps:
 * - Homepage GET / is a large SPA payload (~1.6MB)
 *   and often takes 20–40s per request.
 * - Login GET /login is also a large page and
 *   typically takes 1–6s per request.
 *
 * VU counts stay low so tests exercise profile
 * shape (ramp, spike, sustain, arrival-rate)
 * without flooding the environment.
 *
 * Peak VUs can be overridden at runtime via the
 * k6 runner (--vus or K6_DEFAULT_VUS) without
 * changing these defaults.
 */
export const loadProfiles: Record<
  LoadProfileName,
  LoadProfileDefinition
> = {
  smoke: {
    name: 'smoke',
    description: 'Lightweight 1-VU check that the scenario works.',
    options: {
      vus: 1,
      duration: '30s',
    },
  },

  load: {
    name: 'load',
    description:
      'Gradual traffic: ramp to 4 VUs, hold 8 VUs, then ramp down. Peak 8 VUs over 2 minutes.',
    options: {
      stages: [
        { duration: '30s', target: 4 },
        { duration: '30s', target: 8 },
        { duration: '40s', target: 8 },
        { duration: '20s', target: 0 },
      ],
    },
  },

  stress: {
    name: 'stress',
    description:
      'Progressive increase to find limits: 4 → 8 → 12 → 16 VUs, then down. Peak 16 VUs over 1m40s.',
    options: {
      stages: [
        { duration: '20s', target: 4 },
        { duration: '20s', target: 8 },
        { duration: '20s', target: 12 },
        { duration: '20s', target: 16 },
        { duration: '20s', target: 0 },
      ],
    },
  },

  spike: {
    name: 'spike',
    description:
      'Sudden jump from 2 VUs to 12 VUs, short hold, then recovery. Peak 12 VUs over 1m10s.',
    options: {
      stages: [
        { duration: '20s', target: 2 },
        { duration: '10s', target: 12 },
        { duration: '20s', target: 12 },
        { duration: '10s', target: 2 },
        { duration: '10s', target: 0 },
      ],
    },
  },

  soak: {
    name: 'soak',
    description:
      'Sustained modest traffic for a longer period: 5 VUs for 3 minutes. Total 3m40s. Shortened from a typical multi-hour soak for shared/dev validation.',
    options: {
      stages: [
        { duration: '20s', target: 5 },
        { duration: '3m', target: 5 },
        { duration: '20s', target: 0 },
      ],
    },
  },

  rps: {
    name: 'rps',
    description:
      'Constant arrival rate of 1 request/second for 30s, capped at 8 VUs. Homepage responses are slow, so k6 may not fully sustain 1 rps; maxVUs protects the environment.',
    options: {
      scenarios: {
        default: {
          executor: 'constant-arrival-rate',
          rate: 1,
          timeUnit: '1s',
          duration: '30s',
          preAllocatedVUs: 4,
          maxVUs: 8,
          gracefulStop: '45s',
        },
      },
    },
  },
};

export const k6ProfileOptions: Record<
  LoadProfileName,
  K6ProfileOptions
> = {
  smoke: loadProfiles.smoke.options,
  load: loadProfiles.load.options,
  stress: loadProfiles.stress.options,
  spike: loadProfiles.spike.options,
  soak: loadProfiles.soak.options,
  rps: loadProfiles.rps.options,
};

export function isLoadProfileName(
  value: string
): value is LoadProfileName {
  return loadProfileNames.includes(value as LoadProfileName);
}

/** Peak concurrent VUs (or maxVUs for rps) defined by the profile defaults. */
export function getProfilePeakVus(profile: LoadProfileName): number {
  const options = k6ProfileOptions[profile];

  if ('vus' in options) {
    return options.vus;
  }

  if ('stages' in options) {
    return Math.max(...options.stages.map((stage) => stage.target));
  }

  return options.scenarios.default.maxVUs;
}

/**
 * Apply a runtime VU override while preserving profile shape.
 * - smoke: replace `vus`
 * - staged profiles: scale stage targets so peak equals `vus` (0 stays 0)
 * - rps: keep arrival `rate`; only resize the VU pool (maxVUs / preAllocatedVUs)
 */
export function applyVuOverride(
  options: K6ProfileOptions,
  vus: number
): K6ProfileOptions {
  if (!Number.isInteger(vus) || vus < 1) {
    throw new Error(
      `Invalid VU override: ${vus}. VU must be a positive integer.`
    );
  }

  if ('vus' in options) {
    return {
      ...options,
      vus,
    };
  }

  if ('stages' in options) {
    const peak = Math.max(
      ...options.stages.map((stage) => stage.target)
    );

    if (peak <= 0) {
      return options;
    }

    const scale = vus / peak;

    return {
      stages: options.stages.map((stage) => ({
        duration: stage.duration,
        target:
          stage.target === 0
            ? 0
            : Math.max(1, Math.round(stage.target * scale)),
      })),
    };
  }

  const scenario = options.scenarios.default;

  return {
    scenarios: {
      default: {
        ...scenario,
        maxVUs: vus,
        preAllocatedVUs: Math.max(1, Math.min(vus, Math.ceil(vus / 2))),
      },
    },
  };
}

export function getK6ProfileOptions(
  profile: string,
  overrideVus?: number
): K6ProfileOptions {
  if (!isLoadProfileName(profile)) {
    throw new Error(
      `Invalid k6 profile: ${profile}. Allowed profiles: ${loadProfileNames.join(', ')}`
    );
  }

  const baseOptions = k6ProfileOptions[profile];

  if (overrideVus === undefined) {
    return baseOptions;
  }

  return applyVuOverride(baseOptions, overrideVus);
}
