export const COMPANION_COPY = {
  title: 'Companion',
  subtitle:
    'View accounts, balances, and transactions on Android, relay bank SMS codes, and route selected crawls through the phone’s network.',
  installHeading: 'Install Accrawl Companion',
  installDescription:
    'The Accrawl Companion installs on Android. Download the APK on your Android phone, then open the downloaded file to install it. Android may ask you to allow installs from this source.',
  downloadForAndroid: 'Download for Android',
  downloadQrHelper:
    'Not on your Android phone? Scan this code with your phone to open the same download.',
  downloadQrAlt:
    'QR code linking to the official Accrawl Companion APK download',
  howPairingWorks: 'How pairing works',
  install: 'Open Accrawl Companion on the Android phone you want to pair.',
  selectConnections:
    'Choose the exact connections this phone may access. For those connections only, the phone can access financial data, relay bank SMS codes, and optionally route crawls through its network.',
  createRequest:
    'Create a five-minute pairing request. Scan its QR code or enter its details on the phone, then compare the separate six-digit code before approving the phone here.',
  deviceName: 'Phone name',
  deviceNamePlaceholder: 'For example, Pixel 8',
  connections: 'Connections',
  noConnections:
    'Add a connection before pairing a phone.',
  selectAtLeastOne:
    'Select at least one connection for this phone.',
  createPairingRequest: 'Create pairing request',
  pairingRequest: 'Pairing request',
  qrExplanation:
    'In Accrawl Companion, scan this QR code. It contains only this console’s address and the short-lived pairing code.',
  manualAddress: 'Console address',
  manualCode: 'Pairing code',
  waitingForPhone: 'Waiting for this pairing request to be opened on the phone…',
  compareCode:
    'Compare this code with the code shown on the phone. Approve only if every digit matches.',
  approvePhone: 'Approve phone',
  cancelPairing: 'Cancel pairing',
  pairingApproved:
    'Approved. Keep Accrawl Companion open while it finishes pairing.',
  pairingExpired:
    'This pairing request expired. Create a new request.',
  pairingUsed: 'Pairing complete.',
  pairingCancelled: 'This pairing request was cancelled.',
  createAnotherRequest: 'Create another pairing request',
  pairedPhones: 'Paired phones',
  device: 'Phone',
  access: 'Access',
  status: 'Status',
  lastSeen: 'Last seen',
  never: 'Never',
  noDevices: 'No phones paired',
  noDevicesHelp:
    'Pair a phone to view financial data and relay bank SMS codes for selected connections, and optionally route crawls for those connections through the phone’s network.',
  revokeAction: 'Revoke',
  revokeDeviceTemplate: 'Revoke {name}?',
  revokeConsequence:
    'Revoking immediately ends this phone’s financial access, SMS relay, and device-proxy access for the selected connections. Any crawl using its network route will stop. This does not affect separate sharing with recipient organisations or erase financial data they have already copied.',
  revokePhone: 'Revoke phone',
  selectedConnectionSingular: '1 connection',
  selectedConnectionPluralTemplate: '{count} connections',
  expiresInTemplate: 'Expires in {duration}',
  pairedAtTemplate: 'Paired {when}',
  lastSeenAtTemplate: '{relative} ({absolute})',
  selectedConnectionCount: (count: number) => count === 1
    ? COMPANION_COPY.selectedConnectionSingular
    : COMPANION_COPY.selectedConnectionPluralTemplate.replace('{count}', String(count)),
  expiresIn: (duration: string) =>
    COMPANION_COPY.expiresInTemplate.replace('{duration}', duration),
  pairedAt: (when: string) =>
    COMPANION_COPY.pairedAtTemplate.replace('{when}', when),
  lastSeenAt: (relative: string, absolute: string) =>
    COMPANION_COPY.lastSeenAtTemplate
      .replace('{relative}', relative)
      .replace('{absolute}', absolute),
  revokeDevice: (name: string) =>
    COMPANION_COPY.revokeDeviceTemplate.replace('{name}', name),
} as const;

export const COMPANION_APK_URL = new URL(
  '/downloads/companion.apk',
  typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
).toString();
