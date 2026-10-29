import { discord } from './discord';
import { googlechat } from './googlechat';
import { matrix } from './matrix';
import { mattermost, slack } from './slack';
import { ntfy } from './ntfy';
import { teams } from './teams';
import { telegram } from './telegram';
import { webhook } from './webhook';
import type { Connector } from './types';

export const CONNECTORS: Connector[] = [discord, slack, teams, googlechat, telegram, matrix, mattermost, ntfy, webhook];

export function getConnector(type: string): Connector | undefined {
  return CONNECTORS.find((c) => c.type === type);
}

export { EVENT_TYPES } from './types';
export type { Config, DropEvent, EventType } from './types';
