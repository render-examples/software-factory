export interface ScheduleRecord {
  id: string;
  workflow: string;
  cronExpression: string;
  input?: unknown;
  enabled: boolean;
  /** Owning tenant (from auth at create time). Cron-fired runs inherit it so they
   *  are tenant-scoped like any other run. Undefined for legacy/operator schedules. */
  userId?: string;
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
  /** List schedules, optionally scoped to one tenant (`userId`). */
  listSchedules(opts?: { userId?: string }): Promise<ScheduleRecord[]>;
  listEnabled(): Promise<ScheduleRecord[]>;
}
