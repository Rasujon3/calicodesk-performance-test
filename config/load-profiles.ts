export type LoadProfileName =
  | 'smoke'
  | 'load'
  | 'stress'
  | 'spike'
  | 'soak'
  | 'rps';

export type LoadProfile =
  | {
      name: Exclude<LoadProfileName, 'rps'>;
      description: string;
      type: 'vus';
      vus?: number;
      duration?: string;
      stages?: Array<{
        duration: string;
        target: number;
      }>;
    }
  | {
      name: 'rps';
      description: string;
      type: 'rps';
      rate: number;
      timeUnit: string;
      duration: string;
      preAllocatedVUs: number;
      maxVUs: number;
    };

export const loadProfiles: Record<LoadProfileName, LoadProfile> = {
  smoke: {
    name: 'smoke',
    description: 'Small verification load.',
    type: 'vus',
    vus: 1,
    duration: '30s',
  },

  load: {
    name: 'load',
    description: 'Normal expected load.',
    type: 'vus',
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 25 },
      { duration: '2m', target: 25 },
      { duration: '30s', target: 0 },
    ],
  },

  stress: {
    name: 'stress',
    description: 'Increasing high load.',
    type: 'vus',
    stages: [
      { duration: '30s', target: 25 },
      { duration: '1m', target: 50 },
      { duration: '1m', target: 100 },
      { duration: '1m', target: 150 },
      { duration: '30s', target: 0 },
    ],
  },

  spike: {
    name: 'spike',
    description: 'Sudden traffic spike.',
    type: 'vus',
    stages: [
      { duration: '30s', target: 10 },
      { duration: '10s', target: 100 },
      { duration: '1m', target: 100 },
      { duration: '10s', target: 10 },
      { duration: '30s', target: 0 },
    ],
  },

  soak: {
    name: 'soak',
    description: 'Long-running stability test.',
    type: 'vus',
    stages: [
      { duration: '1m', target: 25 },
      { duration: '10m', target: 25 },
      { duration: '1m', target: 0 },
    ],
  },

  rps: {
    name: 'rps',
    description: 'Constant request-rate test.',
    type: 'rps',
    rate: 10,
    timeUnit: '1s',
    duration: '1m',
    preAllocatedVUs: 5,
    maxVUs: 20,
  },
};