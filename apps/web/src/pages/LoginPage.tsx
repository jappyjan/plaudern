import { useState } from 'react';
import { Button, Divider, Input } from '@heroui/react';
import { useAuth } from '../auth/AuthContext';
import { loginWithPasskey, registerWithPasskey } from '../lib/auth';

/**
 * Passkey-only sign-in. Login is usernameless (the browser offers the
 * discoverable passkeys it holds for this site); registration just needs a
 * username to label the new — fully isolated — account.
 */
export function LoginPage() {
  const { status, refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState<'login' | 'register' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const firstUser = status !== null && !status.usersExist;
  const canRegister = status?.allowRegistration ?? true;

  const run = async (kind: 'login' | 'register', action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      // NotAllowedError is the browser's "user closed the passkey prompt".
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        cause instanceof Error && cause.name === 'NotAllowedError'
          ? 'The passkey prompt was dismissed. Please try again.'
          : message,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Plaudern</h1>
        <p className="mt-1 text-sm text-default-500">
          {firstUser
            ? 'Welcome! Create the first account to get started — it becomes the owner of everything already in this inbox.'
            : 'Sign in with your passkey to continue.'}
        </p>
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {!firstUser && (
        <Button
          color="primary"
          size="lg"
          isLoading={busy === 'login'}
          isDisabled={busy !== null}
          onPress={() => void run('login', loginWithPasskey)}
        >
          Sign in with passkey
        </Button>
      )}

      {canRegister && (
        <>
          {!firstUser && (
            <div className="flex items-center gap-3 text-xs text-default-400">
              <Divider className="flex-1" />
              new here?
              <Divider className="flex-1" />
            </div>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (username.trim()) void run('register', () => registerWithPasskey(username));
            }}
          >
            <Input
              label="Username"
              value={username}
              onValueChange={setUsername}
              autoComplete="username webauthn"
              description="Accounts are fully isolated — nothing is shared between users."
            />
            <Button
              type="submit"
              color={firstUser ? 'primary' : 'default'}
              variant={firstUser ? 'solid' : 'flat'}
              size="lg"
              isLoading={busy === 'register'}
              isDisabled={busy !== null || !username.trim()}
            >
              Create account with passkey
            </Button>
          </form>
        </>
      )}

      {!canRegister && !firstUser && (
        <p className="text-center text-xs text-default-400">
          Registration is disabled on this instance.
        </p>
      )}

      <p className="text-center text-xs text-default-400">
        Passkeys use your device&apos;s screen lock or security key — there are no passwords.
      </p>
    </div>
  );
}
