import { ref, watch } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';
import { useAuthStore } from '../stores/auth.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Three stores share this core. The server returns gateway-wide rows for admin
// sessions and user-scoped rows otherwise; each consuming surface applies any
// narrower API-key projection it needs. The stores differ only in query flags:
// `useModelsStore` synthesises alias entries (the default `/v1/models` view);
// `useRawModelsStore` drops alias merging and adds `include_unlisted=true` so
// the alias editor sees every id the resolver accepts; `useAddressableModelsStore`
// retains aliases and unlisted ids so Agent Setup can project the complete
// addressable surface through the selected API key.
const makeStore = (params: { includeAliases: boolean; includeUnlisted?: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let inflight: Promise<void> | null = null;
  let principalStore: ReturnType<typeof useAuthStore> | null = null;
  let principalToken: string | null = null;
  let principalGeneration = 0;
  let requestSequence = 0;
  let activeRequestId = 0;
  let stopPrincipalWatch: (() => void) | null = null;

  const selectPrincipal = (store: ReturnType<typeof useAuthStore>, token: string | null) => {
    if (principalStore === store && principalToken === token) return;
    principalStore = store;
    principalToken = token;
    principalGeneration += 1;
    inflight = null;
    models.value = null;
    loading.value = false;
    error.value = null;
  };

  const bindPrincipal = (store: ReturnType<typeof useAuthStore>) => {
    if (principalStore === store) return;
    stopPrincipalWatch?.();
    selectPrincipal(store, store.authToken);
    stopPrincipalWatch = watch(
      () => store.authToken,
      token => selectPrincipal(store, token),
      { flush: 'sync' },
    );
  };

  return () => {
    const api = useApi();
    const auth = useAuthStore();
    bindPrincipal(auth);

    const load = (): Promise<void> => {
      selectPrincipal(auth, auth.authToken);
      if (inflight !== null) return inflight;

      const generation = principalGeneration;
      const requestId = ++requestSequence;
      activeRequestId = requestId;
      inflight = (async () => {
        loading.value = true;
        error.value = null;
        try {
          const query: { aliases?: 'false'; include_unlisted?: 'true' } = {};
          if (!params.includeAliases) query.aliases = 'false';
          if (params.includeUnlisted) query.include_unlisted = 'true';
          const result = await callApi<ModelsResponse>(() => api.api.models.$get({ query }));
          if (generation !== principalGeneration || requestId !== activeRequestId) return;
          if (result.error) error.value = result.error.message;
          else models.value = result.data.data;
        } finally {
          if (generation === principalGeneration && requestId === activeRequestId) {
            loading.value = false;
            inflight = null;
          }
        }
      })();
      return inflight;
    };

    return { models, loading, error, load };
  };
};

export const useModelsStore = makeStore({ includeAliases: true });
export const useRawModelsStore = makeStore({ includeAliases: false, includeUnlisted: true });
export const useAddressableModelsStore = makeStore({ includeAliases: true, includeUnlisted: true });
