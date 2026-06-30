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

export function eventAdminAccessForRequest(request: Request): EventAdminAccess {
  const roles = cmsUserRoles(request);

  // Direct secret-authenticated calls predate x-cms-user forwarding in tests and
  // local tooling. Treat those as trusted full-access calls.
  if (!roles.length) return { ...FULL_ACCESS };
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const canView = roles.includes('moderator') || roles.includes('event-helper');
  if (!canView) return { ...NO_ACCESS };

  return {
    canView: true,
    canEdit: false,
    canDelete: false,
    canImportExport: false,
    canCheckIn: roles.includes('event-helper'),
    canManageEmail: false,
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

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
