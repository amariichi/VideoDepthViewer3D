export type ClientMode = 'remote' | 'viewer';

export interface ClientModeEnvironment {
  search?: string;
  userAgent?: string;
  userAgentMobile?: boolean;
  platform?: string;
  maxTouchPoints?: number;
}

export function resolveClientMode(environment: ClientModeEnvironment = {}): ClientMode {
  const browserNavigator =
    typeof navigator === 'undefined'
      ? ({ userAgent: '', platform: '', maxTouchPoints: 0 } as Navigator)
      : navigator;
  const search =
    environment.search ??
    (typeof window === 'undefined' ? '' : window.location.search);
  const override = new URLSearchParams(search).get('mode');
  if (override === 'remote' || override === 'viewer') return override;

  const navigatorWithHints = browserNavigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  const userAgent = environment.userAgent ?? browserNavigator.userAgent;
  const userAgentMobile =
    environment.userAgentMobile ?? navigatorWithHints.userAgentData?.mobile ?? false;
  const platform = environment.platform ?? browserNavigator.platform;
  const maxTouchPoints =
    environment.maxTouchPoints ?? browserNavigator.maxTouchPoints ?? 0;
  const ipadDesktopIdentity =
    platform === 'MacIntel' && maxTouchPoints > 1;

  return userAgentMobile || /Android|iPhone|iPad|iPod/i.test(userAgent) || ipadDesktopIdentity
    ? 'remote'
    : 'viewer';
}
