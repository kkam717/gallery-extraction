/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BASE_PATH?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_API_KEY?: string;
  readonly VITE_GOOGLE_APP_ID?: string;
  readonly VITE_EXTRACT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
