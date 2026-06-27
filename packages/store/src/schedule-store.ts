export interface ScheduleRecord {
  id: string;
  workflow: string;
  cronExpression: string;
  input?: unknown;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleStore {
  createSchedule(schedule: ScheduleRecord): Promise<void>;
  getSchedule(id: string): Promise<ScheduleRecord | undefined>;
  updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  listEnabled(): Promise<ScheduleRecord[]>;
}
