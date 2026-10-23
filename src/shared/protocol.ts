import type { DisplayPolicy } from './settings';

export const STATUS_MESSAGE = 'wss:status';

export interface ContentStatus {
  active: boolean;
  enabled: boolean;
  siteEnabled: boolean;
  host: string;
  url: string;
  title: string;
  viewport: string;
  headings: number;
  scope: string | null;
  stats: string | null;
  statusReason: string;
  isReadingCandidate: boolean;
  geometryReliable: boolean;
  pageTocVisible: boolean;
  dockTop: number;
  layerZIndex: number;
  contentVersion: string;
  displayPolicy: DisplayPolicy;
  currentSection: string | null;
}

