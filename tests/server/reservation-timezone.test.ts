import assert from 'node:assert/strict';
import test from 'node:test';
import { reservationDayRange, reservationInstant, reservationLocalDateTime } from '../../shared/time-reservations.js';

test('the team clock round-trips minute bookings and a full local day across UTC midnight', () => {
  assert.equal(reservationInstant('2026-11-20T08:30'), '2026-11-19T23:30:00.000Z');
  assert.equal(reservationLocalDateTime('2026-11-19T23:30:00.000Z'), '2026-11-20T08:30');
  assert.deepEqual(reservationDayRange('2026-11-20'), {
    startAt: '2026-11-19T15:00:00.000Z',
    endAt: '2026-11-20T15:00:00.000Z',
  });
  for (const value of ['2026-02-29T10:00', '2026-11-20T24:00', '2026-11-20 09:00', '2026-11-20T09:00:12']) {
    assert.equal(reservationInstant(value), null, value);
  }
  assert.equal(reservationLocalDateTime('invalid'), '');
  assert.equal(reservationInstant('2026-11-20T09:00', 'No/Such_Zone'), null);
});

test('gap and repeated local minutes are not silently resolved and daily windows use real elapsed time', () => {
  const zone = 'America/New_York';
  assert.equal(reservationInstant('2026-03-08T02:30', zone), null);
  assert.equal(reservationInstant('2026-11-01T01:30', zone), null);
  assert.equal(reservationInstant('2026-11-01T02:30', zone), '2026-11-01T07:30:00.000Z');
  assert.deepEqual(reservationDayRange('2026-03-08', zone), {
    startAt: '2026-03-08T05:00:00.000Z',
    endAt: '2026-03-09T04:00:00.000Z',
  });
  assert.deepEqual(reservationDayRange('2026-11-01', zone), {
    startAt: '2026-11-01T04:00:00.000Z',
    endAt: '2026-11-02T05:00:00.000Z',
  });
  assert.deepEqual(reservationDayRange('2018-11-04', 'America/Sao_Paulo'), {
    startAt: '2018-11-04T03:00:00.000Z',
    endAt: '2018-11-05T02:00:00.000Z',
  });
  assert.equal(reservationDayRange('2011-12-30', 'Pacific/Apia'), null);
});
