export const MSG = {
  GET_STATE:           'GET_STATE',
  GENERATE_KEY:        'GENERATE_KEY',
  GET_KEY_INFO:        'GET_KEY_INFO',
  INIT_VAULT:          'INIT_VAULT',
  UNLOCK:              'UNLOCK',
  LOCK:                'LOCK',
  GET_VAULT:           'GET_VAULT',
  SAVE_VAULT:          'SAVE_VAULT',
  GET_KEYS:            'GET_KEYS',
  ADD_KEY:             'ADD_KEY',
  REMOVE_KEY:          'REMOVE_KEY',
  GET_CREDENTIAL:      'GET_CREDENTIAL',
  EXPORT_VAULT:        'EXPORT_VAULT',
  IMPORT_VAULT:        'IMPORT_VAULT',
  EXPORT_CREDENTIALS:  'EXPORT_CREDENTIALS',
  IMPORT_CREDENTIALS:  'IMPORT_CREDENTIALS',
  GET_SETTINGS:        'GET_SETTINGS',
  SAVE_SETTINGS:       'SAVE_SETTINGS',
  RESET_VAULT:         'RESET_VAULT',
  // Service worker → content script
  SHOW_TOAST:          'SHOW_TOAST',
  // Content script → service worker
  OPEN_POPUP:          'OPEN_POPUP',
  DISMISS_TOAST:       'DISMISS_TOAST',
  // Service worker → all extension pages
  VAULT_READY:         'VAULT_READY',
  VAULT_LOCKED:        'VAULT_LOCKED',
};

export const DEFAULTS = {
  AUTO_LOCK_MINUTES: 15,
  DISMISS_MINUTES:    0,   // 0 = until tab closes
};
