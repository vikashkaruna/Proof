-- ─────────────────────────────────────────────────────────────────────
-- 0010_ledger_kill_switch_released.sql
-- Adds 'execution.kill_switch.released' to the ledger action enum.
--
-- The enum had only 'execution.kill_switch.engaged', so releasing the
-- kill switch appended an entry saying it had been ENGAGED. The audit
-- trail recorded the opposite of what happened, and on a product whose
-- proposition is a tamper-evident ledger that is not cosmetic: a
-- reviewer reconstructing an incident would conclude execution was
-- halted at the moment it was resumed.
-- ─────────────────────────────────────────────────────────────────────

alter type ledger_action_type add value if not exists 'execution.kill_switch.released';
