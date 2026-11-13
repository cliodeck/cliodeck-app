/**
 * `unwrapIpc` (L09-2) : `ipcRenderer.invoke` résout même quand le handler a échoué. Un échec
 * répondu devient une exception, que le `catch` de l'appelant voit enfin.
 */
import { describe, expect, it } from 'vitest';
import { IpcError, NO_RESPONSE_ISSUE_CODE, unwrapIpc } from '../ipc-outcome';
import { UNEXPECTED_ISSUE_CODE } from '@backend/types/outcome';

function caught(run: () => unknown): IpcError {
  try {
    run();
  } catch (error) {
    if (error instanceof IpcError) return error;
    throw error;
  }
  throw new Error('unwrapIpc aurait dû lever');
}

describe('unwrapIpc', () => {
  it('rend la réponse même quand le main a réussi, avertissements compris', () => {
    const res = { success: true, saved: 2, warnings: [{ code: 'settings.servicesNotReloaded' }] };

    expect(unwrapIpc(res)).toBe(res);
  });

  it('lève sur success: false, avec le code et les paramètres du main', () => {
    const error = caught(() =>
      unwrapIpc({
        success: false,
        error: 'EACCES',
        errorCode: 'settings.saveRefused',
        errorParams: { section: 'llm' },
      })
    );

    expect(error.code).toBe('settings.saveRefused');
    expect(error.params).toEqual({ section: 'llm' });
    expect(error.message).toBe('EACCES');
  });

  it('lève sur une réponse de errorResponse, cause brute sous le code qui ne qualifie rien', () => {
    const error = caught(() => unwrapIpc({ success: false, error: 'No project open' }));

    expect(error.code).toBe(UNEXPECTED_ISSUE_CODE);
    expect(error.message).toBe('No project open');
  });

  it("lève quand le main n'a rien répondu", () => {
    expect(caught(() => unwrapIpc(undefined)).code).toBe(NO_RESPONSE_ISSUE_CODE);
    expect(caught(() => unwrapIpc(null)).code).toBe(NO_RESPONSE_ISSUE_CODE);
  });
});
