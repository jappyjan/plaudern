import { maskSpans } from '@plaudern/contracts';
import {
  detectCreditCards,
  detectDeterministic,
  detectIbans,
  detectCredentials,
  detectNationalIds,
  ibanValid,
  luhnValid,
} from './detectors';

describe('deterministic sensitivity detectors', () => {
  describe('credit cards (Luhn)', () => {
    it('detects a valid Visa test number and marks it secret', () => {
      const text = 'my card is 4111 1111 1111 1111 ok';
      const spans = detectCreditCards(text);
      expect(spans).toHaveLength(1);
      expect(spans[0].category).toBe('credit_card');
      expect(text.slice(spans[0].start, spans[0].end)).toBe('4111 1111 1111 1111');
      expect(detectDeterministic(text).tier).toBe('secret');
    });

    it('ignores a 16-digit run that fails the Luhn check', () => {
      expect(detectCreditCards('number 1234 5678 9012 3456 here')).toHaveLength(0);
    });

    it('ignores short numeric runs (phone numbers, amounts)', () => {
      expect(detectCreditCards('call 555 1234 or pay 42')).toHaveLength(0);
    });

    it('luhnValid agrees with known vectors', () => {
      expect(luhnValid('4111111111111111')).toBe(true);
      expect(luhnValid('1234567890123456')).toBe(false);
    });
  });

  describe('IBAN (mod-97)', () => {
    it('detects a valid German example IBAN and marks it sensitive', () => {
      const text = 'transfer to DE89 3704 0044 0532 0130 00 today';
      const spans = detectIbans(text);
      expect(spans).toHaveLength(1);
      expect(spans[0].category).toBe('iban');
      expect(detectDeterministic(text).tier).toBe('sensitive');
    });

    it('rejects an IBAN-shaped token with a bad checksum', () => {
      expect(detectIbans('code DE00 3704 0044 0532 0130 00 nope')).toHaveLength(0);
    });

    it('ibanValid agrees with known vectors', () => {
      expect(ibanValid('DE89370400440532013000')).toBe(true);
      expect(ibanValid('GB82WEST12345698765432')).toBe(true);
      expect(ibanValid('DE00370400440532013000')).toBe(false);
    });
  });

  describe('credentials', () => {
    it('masks the value after a password keyword', () => {
      const text = 'the password: hunter2xyz for the router';
      const spans = detectCredentials(text);
      expect(spans).toHaveLength(1);
      expect(text.slice(spans[0].start, spans[0].end)).toBe('hunter2xyz');
      expect(detectDeterministic(text).tier).toBe('secret');
    });

    it('detects api key assignments and bearer tokens', () => {
      expect(detectCredentials('api_key = sk-abc123def456ghi')).toHaveLength(1);
      expect(detectCredentials('Authorization: Bearer ey.abc123.def456ghi789')).toHaveLength(1);
    });

    it('detects AWS access key ids and PEM private key blocks', () => {
      expect(detectCredentials('key AKIAIOSFODNN7EXAMPLE rotated')).toHaveLength(1);
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      expect(detectCredentials(pem)).toHaveLength(1);
    });

    it('does not fire on ordinary prose', () => {
      expect(detectCredentials('we discussed the secret garden book')).toHaveLength(0);
    });
  });

  describe('national ids', () => {
    it('detects a US SSN as sensitive', () => {
      const spans = detectNationalIds('ssn 123-45-6789 on file');
      expect(spans).toHaveLength(1);
      expect(spans[0].category).toBe('national_id');
    });
  });

  describe('folding + masking', () => {
    it('normal text yields the normal tier and no spans', () => {
      const result = detectDeterministic('just a normal chat about lunch plans');
      expect(result.tier).toBe('normal');
      expect(result.spans).toHaveLength(0);
      expect(result.detections).toHaveLength(0);
    });

    it('takes the most sensitive tier across mixed detections', () => {
      const text = 'iban DE89 3704 0044 0532 0130 00 and password: topsecret1';
      const result = detectDeterministic(text);
      expect(result.tier).toBe('secret'); // credential beats iban
      const masked = maskSpans(text, result.spans);
      expect(masked).not.toContain('topsecret1');
      expect(masked).not.toContain('DE89 3704 0044 0532 0130 00');
      expect(masked).toContain('••••••');
    });
  });
});
