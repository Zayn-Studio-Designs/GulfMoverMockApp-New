import type { PublicAccount } from '../context/AuthContext';

/** Profile picture, or initials from the username when no picture is set. */
export function Avatar({ user, size = 34 }: { user: Pick<PublicAccount, 'username' | 'avatar'>; size?: number }) {
  const initials = user.username.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'GM';
  return user.avatar
    ? <img className="avatar avatar-img" src={user.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>{initials}</span>;
}
