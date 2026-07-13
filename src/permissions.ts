export interface EventAdminAccess {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canImportExport: boolean;
  canCheckIn: boolean;
  canManageEmail: boolean;
}

const FULL_ACCESS: EventAdminAccess = {
  canView: true,
  canEdit: true,
  canDelete: true,
  canImportExport: true,
  canCheckIn: true,
  canManageEmail: true,
};

const NO_ACCESS: EventAdminAccess = {
  canView: false,
  canEdit: false,
  canDelete: false,
  canImportExport: false,
  canCheckIn: false,
  canManageEmail: false,
};

/**
 * The signed-in CMS user's id from the forwarded `x-cms-user` summary, or
 * null on direct/anonymous calls. Echoed back to the host on CMS writes
 * (x-acting-user-id) so credit costs are charged to the right user.
 */
export function cmsUserId(request: Request): string | null {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === 'string' && parsed.id.trim()) return parsed.id.trim();
    if (typeof parsed.id === 'number' && Number.isFinite(parsed.id)) return String(parsed.id);
    return null;
  } catch {
    return null;
  }
}

export function eventAdminAccessForRequest(request: Request): EventAdminAccess {
  const roles = cmsUserRoles(request);
  const permissions = cmsUserPermissions(request);

  // Direct secret-authenticated calls predate x-cms-user forwarding in tests and
  // local tooling. Treat those as trusted full-access calls.
  if (!roles.length) return { ...FULL_ACCESS };
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const canWrite = permissions.includes('events:write');
  const canView = canWrite
    || permissions.includes('events:view')
    || permissions.includes('events:checkin')
    || roles.includes('moderator')
    || roles.includes('event-helper');
  if (!canView) return { ...NO_ACCESS };

  return {
    canView: true,
    canEdit: canWrite,
    canDelete: canWrite,
    canImportExport: false,
    canCheckIn: permissions.includes('events:checkin') || roles.includes('event-helper'),
    canManageEmail: canWrite,
  };
}

function cmsUserRoles(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { role?: unknown };
    if (typeof parsed.role !== 'string') return [];
    return [...new Set(parsed.role.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function cmsUserPermissions(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { permissions?: unknown };
    if (Array.isArray(parsed.permissions)) {
      return [...new Set(parsed.permissions
        .filter((permission): permission is string => typeof permission === 'string')
        .map((permission) => permission.trim().toLowerCase())
        .filter(Boolean))];
    }
    if (typeof parsed.permissions === 'string') {
      return [...new Set(parsed.permissions.split(',').map((permission) => permission.trim().toLowerCase()).filter(Boolean))];
    }
    return [];
  } catch {
    return [];
  }
}

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}

/** Archived event trees are read-only until the event is restored. */
export function archivedEventImmutable(): Response {
  return new Response('Archived events are read-only. Restore the event before making changes.', { status: 409 });
}
