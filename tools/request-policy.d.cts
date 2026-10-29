import { AsyncLocalStorage } from 'node:async_hooks';
export const requestBudget: AsyncLocalStorage<{signal:AbortSignal;mutation:boolean;dispatched?:boolean}>;
export function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
export const MAX_RESPONSE_BYTES: number;
