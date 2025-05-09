import { App, ComputedRef, Plugin, computed, ref } from 'vue';

import http from '@/http';
import type { components } from '@/types';
import router from '@/router';
import { differenceInMilliseconds, subMinutes } from 'date-fns';
import { routes } from '@/routes.ts';
import { getInstanceConfig } from '@/utils/biscuit_auth';
import formbricks from '@formbricks/js';

type definitions = components['schemas'];
type LoginResponse = definitions['LoginResponse'];

interface State {
  accessToken: string;
  accessTokenExpiration: Date;
  refreshToken: string;
  refreshTokenExpiration: Date;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

const localStorageKey = 'auth';

const state = ref<null | State>(null);
let refreshTimerId: null | number = null;

function readStateFromStorage(): State | null {
  const data = window.localStorage.getItem(localStorageKey);

  if (data !== null) {
    const parsed = JSON.parse(data) as {
      accessToken: string;
      accessTokenExpiration: string;
      refreshToken: string;
      refreshTokenExpiration: string;
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
    } | null;

    if (parsed !== null) {
      const accessTokenExpirationDate = new Date(parsed.accessTokenExpiration);
      const refreshTokenExpirationDate = new Date(parsed.refreshTokenExpiration);

      if (refreshTokenExpirationDate <= new Date()) {
        return null;
      } else {
        const state: State = {
          ...parsed,
          accessTokenExpiration: accessTokenExpirationDate,
          refreshTokenExpiration: refreshTokenExpirationDate,
        };
        return state;
      }
    } else {
      return null;
    }
  } else {
    return null;
  }
}

function writeStateToStorage(state: State): void {
  window.localStorage.setItem(localStorageKey, JSON.stringify(state));
}

function removeStateFromStorage(): void {
  window.localStorage.removeItem(localStorageKey);
}

async function scheduleAutoRefresh(): Promise<void> {
  if (refreshTimerId != null) {
    clearTimeout(refreshTimerId);
  }

  if (state.value) {
    if (state.value.refreshTokenExpiration <= new Date()) {
      state.value = null;
      removeStateFromStorage();
    } else {
      if (state.value.accessTokenExpiration <= new Date()) {
        await refresh().catch(() => {
          console.log('Could not refresh access token, logging out...');

          state.value = null;
          removeStateFromStorage();
        });
      } else {
        const refreshInMs = differenceInMilliseconds(
          subMinutes(state.value.accessTokenExpiration, 1),
          new Date()
        );
        console.log(`Will refresh access token in ${refreshInMs / 1000}s...`);

        refreshTimerId = window.setTimeout(() => {
          console.log('Refreshing access token...');
          refresh().catch(console.error);
        }, refreshInMs);
      }
    }
  } else {
    console.error('Cannot enable token auto refresh is not logged in');
  }
}

export async function login(email: string, password: string): Promise<void> {
  const res = await http.unauthenticated.post<LoginResponse>('/auth/login', {
    email,
    password,
  });
  state.value = {
    accessToken: res.data.access_token,
    accessTokenExpiration: new Date(res.data.access_token_expiration),
    refreshToken: res.data.refresh_token,
    refreshTokenExpiration: new Date(res.data.refresh_token_expiration),
    userId: res.data.user_id,
    email: res.data.email,
    firstName: res.data.first_name,
    lastName: res.data.last_name,
  };
  if (state.value) {
    writeStateToStorage(state.value);
    await scheduleAutoRefresh();
    await formbricks.setUserId(state.value.userId).catch((e) => {
      console.warn(`Formbricks setUserId failed: ${e}`);
    });
  }
}

export async function register(
  email: string,
  firstName: string,
  lastName: string,
  password: string,
  turnstile_token?: string
): Promise<void> {
  return http.unauthenticated.post('/register', {
    email,
    first_name: firstName,
    last_name: lastName,
    password,
    turnstile_token,
  });
}

export async function refresh(): Promise<void> {
  if (state.value) {
    const res = await http.withRefreshToken.post<LoginResponse>('/auth/refresh');
    state.value = {
      accessToken: res.data.access_token,
      accessTokenExpiration: new Date(res.data.access_token_expiration),
      refreshToken: res.data.refresh_token,
      refreshTokenExpiration: new Date(res.data.refresh_token_expiration),
      userId: res.data.user_id,
      email: res.data.email,
      firstName: res.data.first_name,
      lastName: res.data.last_name,
    };
    if (state.value) {
      writeStateToStorage(state.value);
      await scheduleAutoRefresh();
    }
  }
}

export async function logout(): Promise<void> {
  if (state.value) {
    try {
      await http.post('/auth/logout');
    } catch (e) {
      console.error(`Logout failed: ${JSON.stringify(e as Error)}`);
    }

    await clearTokens();
  }
}

export function getAccessToken(): ComputedRef<null | string> {
  return computed(() => state.value?.accessToken ?? null);
}

export function getRefreshToken(): ComputedRef<null | string> {
  return computed(() => state.value?.refreshToken ?? null);
}

export async function clearTokens(): Promise<void> {
  if (refreshTimerId !== null) {
    clearTimeout(refreshTimerId);
  }
  state.value = null;
  removeStateFromStorage();
  await router.push({ name: routes.Login });
  if (window.formbricks) {
    await formbricks.logout().catch(console.warn);
  }
}

export interface UserInfo {
  email: string;
  firstName: string;
  lastName: string;
  name: string;
}

export function getUserInfo(): ComputedRef<null | UserInfo> {
  return computed(() => {
    if (state.value) {
      return {
        email: state.value.email,
        firstName: state.value.firstName,
        lastName: state.value.lastName,
        name: `${state.value.firstName} ${state.value.lastName}`,
      };
    } else {
      return null;
    }
  });
}

async function initializeFormbricks() {
  if (typeof window !== 'undefined') {
    const instanceConfig = await getInstanceConfig();
    if (
      instanceConfig &&
      instanceConfig.formbricks &&
      instanceConfig.formbricks.api_host &&
      instanceConfig.formbricks.environment_id
    ) {
      await formbricks
        .setup({
          appUrl: instanceConfig.formbricks.api_host,
          environmentId: instanceConfig.formbricks.environment_id,
        })
        .catch((e) => {
          console.warn(`Formbricks initialization failed: ${e}`);
        });
    }
  }
}

export const AuthPlugin: Plugin = {
  install(_app: App, _options: unknown) {
    initializeFormbricks().catch(console.warn);
    const storedState = readStateFromStorage();
    if (storedState !== null) {
      state.value = storedState;
      scheduleAutoRefresh().catch(console.error);
    } else {
      removeStateFromStorage();
      if (window.formbricks) {
        formbricks.logout().catch(console.warn);
      }
    }

    router.beforeEach(async (to, _from) => {
      // If the route requires authentication, the user is logged in and the route is not a tutorial, track the event
      if (
        window.formbricks &&
        (to.meta?.requiresAuth ?? true) &&
        state.value !== null &&
        !(to.meta?.tutorial ?? false)
      ) {
        await formbricks.registerRouteChange().catch((e) => {
          console.warn(`Formbricks register route change failed: ${e}`);
        });
        await formbricks.track('route_changed').catch((e) => {
          console.warn(`Formbricks track failed: ${e}`);
        });
      }

      // If the route requires authentication and the user is not logged in, redirect to the login page
      if ((to.meta?.requiresAuth ?? true) && state.value === null) {
        return { name: routes.Login };
      }
      // If the route does not require authentication and does not have a redirectIfLoggedIn meta set to false while the user is logged in, then we redirect to the home page
      else if (
        !(to.meta?.requiresAuth ?? true) &&
        (to.meta?.redirectIfLoggedIn ?? true) &&
        state.value !== null
      ) {
        return { name: routes.Home };
      }
      return true;
    });
  },
};
