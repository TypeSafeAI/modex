// Both qualification launchers apply these bytes to the complete native canary tree.
export const LOOPBACK_ONLY_POLICY = '(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n';
