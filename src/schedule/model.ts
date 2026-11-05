// Internal outage-schedule model: the rest of the bot knows only this, never YASNO's shapes.

export type DayStatus = 'applies' | 'waiting' | 'emergency' | 'unknown';

/** Epoch ms, end exclusive. */
export interface Span {
  start: number;
  end: number;
}

export interface ScheduleDay {
  date: string; // yyyy-mm-dd, Kyiv
  status: DayStatus;
  outages: Span[]; // planned outages, merged, sorted
}

export interface Schedule {
  group: string; // e.g. "52.1"
  days: ScheduleDay[]; // today, tomorrow
  updatedAt: number | null; // when YASNO last changed it
  fetchedAt: number; // when we got it
  unknownTypes: string[]; // slot types we didn't recognize (treated as outages)
}

export interface Address {
  streetId: number;
  street: string;
  houseId: number;
  house: string;
  group: string;
}
