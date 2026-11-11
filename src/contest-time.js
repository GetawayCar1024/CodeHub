const MINUTE = 60000;

export function extraMinutes(c, uid) {
  const value = c.extraMinutes?.[uid];
  return Number.isInteger(value) && value >= 0 && value <= 10080 ? value : 0;
}
export const contestantEnd = (c, uid) => c.endTime + extraMinutes(c, uid) * MINUTE;

export function allowedFor(c, user) {
  return !c.groups?.length || (user.groups || []).some(group => c.groups.includes(group));
}

export function contestPhase(c, now = Date.now(), uid) {
  if (now < c.startTime - (c.earlyMinutes ?? 30) * MINUTE) return 'upcoming';
  if (now < c.startTime) return 'before';
  return now < contestantEnd(c, uid) ? 'running' : 'ended';
}

export function endTimes(c, users) {
  return [...new Set([c.endTime, ...users.filter(user => user.role !== 'admin' && allowedFor(c, user)).map(user => contestantEnd(c, user.id))])];
}
export const lastEnd = (c, users) => Math.max(...endTimes(c, users));
