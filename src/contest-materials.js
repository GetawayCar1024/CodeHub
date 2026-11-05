// Offsets are minutes BEFORE the contest starts; larger values mean earlier release.
// Missing fields preserve pre-0.1.5 contests: download on entry, password at the start.
export function materialTiming(contest) {
  return {
    downZipReleaseMinutes: contest.downZipReleaseMinutes ?? contest.earlyMinutes ?? 30,
    passwordReleaseMinutes: contest.passwordReleaseMinutes ?? 0,
  };
}

// Both the detail response and direct download route use this server-side decision.
// Never send a pending password and rely on the browser merely to hide it.
export function contestMaterials(contest, now = Date.now()) {
  const timing = materialTiming(contest);
  const downZipReleaseAt = contest.startTime - timing.downZipReleaseMinutes * 60000;
  const passwordReleaseAt = contest.startTime - timing.passwordReleaseMinutes * 60000;
  const state = (configured, releaseAt) => !configured ? 'unset' : now >= releaseAt ? 'available' : 'pending';
  const downZipState = state(contest.downZip, downZipReleaseAt);
  const passwordState = state(contest.downZipPassword, passwordReleaseAt);
  return {
    hasDownZip: !!contest.downZip,
    downZip: downZipState === 'available',
    downZipState,
    downZipReleaseAt: contest.downZip ? downZipReleaseAt : null,
    hasPassword: !!contest.downZipPassword,
    password: passwordState === 'available' ? contest.downZipPassword : null,
    passwordState,
    passwordReleaseAt: contest.downZipPassword ? passwordReleaseAt : null,
  };
}
