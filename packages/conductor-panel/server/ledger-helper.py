"""Retained POSIX owner for Remedy's local SQLite claim ledger.

No remote I/O, lease expiry, lock unlink or claim deletion. Offline resolution
requires exclusive ownership and an explicit preserved operator decision.
The line protocol is private to durable-ledger.ts; errors never include input bytes.
"""
import argparse
import datetime
import errno
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import sys
import uuid


class Rejected(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Ledger:
    def __init__(self, args):
        self.args = args
        self.current_command = None
        self.directory = os.path.realpath(args.directory)
        self.fence = os.path.join(os.path.realpath(os.path.dirname(args.fence)), os.path.basename(args.fence))
        if not os.path.isdir(self.directory) or not os.path.isdir(os.path.dirname(self.fence)):
            raise ValueError()
        if os.path.commonpath([self.directory, self.fence]) == self.directory or not args.epoch:
            raise ValueError()
        self.lock_path = os.path.join(self.directory, 'owner.lock')
        # In production Node retains the same open-file description, so helper
        # death cannot release ownership during a Node-side remote dispatch.
        self.lock_fd = os.dup(args.owner_fd) if args.owner_fd is not None else os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock_stat = os.fstat(self.lock_fd)
        lock_path_stat = os.stat(self.lock_path, follow_symlinks=False)
        if not stat.S_ISREG(self.lock_stat.st_mode) or (lock_path_stat.st_ino, lock_path_stat.st_dev) != (self.lock_stat.st_ino, self.lock_stat.st_dev):
            raise ValueError()
        os.fsync(self.lock_fd)
        sync_directory(self.directory)
        self.db_path = os.path.join(self.directory, 'claims.sqlite3')
        db_exists, fence_exists = os.path.lexists(self.db_path), os.path.lexists(self.fence)
        fresh = not db_exists and not fence_exists
        if fresh and not args.initialize or db_exists != fence_exists:
            raise ValueError()
        if fresh and any(os.path.lexists(self.db_path + suffix) for suffix in ('-wal', '-shm')):
            raise ValueError()
        if db_exists and (os.path.islink(self.db_path) or not stat.S_ISREG(os.stat(self.db_path).st_mode)):
            raise ValueError()
        self.db = sqlite3.connect(self.db_path, isolation_level=None, timeout=0)
        os.chmod(self.db_path, 0o600)
        self.db.row_factory = sqlite3.Row
        if self.db.execute('PRAGMA journal_mode=WAL').fetchone()[0] != 'wal':
            raise ValueError()
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        if fresh:
            self.db.executescript('''BEGIN IMMEDIATE;
                CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), trust_epoch TEXT NOT NULL, durability_seq INTEGER NOT NULL);
                CREATE TABLE claims (operation_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, jti TEXT NOT NULL, preview_token TEXT NOT NULL UNIQUE,
                    hostname TEXT NOT NULL, page_id TEXT NOT NULL, binding_sha256 TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL,
                    action TEXT NOT NULL CHECK(action IN ('cxone.apply','cxone.restore')), state TEXT NOT NULL,
                    outcome TEXT NOT NULL, reason TEXT, audit_recorded INTEGER, target_active INTEGER NOT NULL,
                    snapshot_path TEXT, cxone_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(issuer,jti));
                CREATE UNIQUE INDEX target_owner ON claims(hostname,page_id) WHERE target_active=1;
                CREATE TABLE revocations (kid TEXT PRIMARY KEY, revoked_at TEXT NOT NULL);
                COMMIT;''')
            self.db.execute('INSERT INTO meta VALUES (1, ?, 0)', (args.epoch,))
            sync_directory(self.directory)
            self.write_fence(0)
        if self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError()
        self.check()
        recovery = self.db.execute("SELECT 1 FROM claims WHERE outcome='pending' LIMIT 1").fetchone()
        if recovery and args.offline_resolve is None:
            def recover():
                self.db.execute("UPDATE claims SET outcome=CASE state WHEN 'write_started' THEN 'unknown_write' ELSE 'not_attempted' END, reason=CASE state WHEN 'write_started' THEN 'write_outcome_unknown' ELSE 'pre_dispatch_failure' END, target_active=CASE state WHEN 'write_started' THEN 1 ELSE 0 END, state='terminal', updated_at=? WHERE outcome='pending'", (now(),))
            self.mutate(recover)

    @staticmethod
    def read_fence(path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError()
            with os.fdopen(fd, 'r', encoding='utf-8') as handle:
                fd = None
                value = json.load(handle)
        finally:
            if fd is not None:
                os.close(fd)
        if set(value) != {'trust_epoch', 'durability_seq'} or type(value['durability_seq']) is not int:
            raise ValueError()
        return value

    def fence_value(self):
        return self.read_fence(self.fence)

    def check(self):
        current = os.stat(self.lock_path, follow_symlinks=False)
        if (current.st_ino, current.st_dev) != (self.lock_stat.st_ino, self.lock_stat.st_dev):
            raise ValueError()
        meta = self.db.execute('SELECT trust_epoch, durability_seq FROM meta WHERE singleton=1').fetchone()
        if meta is None or dict(meta) != self.fence_value() or meta['trust_epoch'] != self.args.epoch:
            raise ValueError()

    def write_fence(self, seq):
        # Never replace/unlink owner.lock. Only the independent fence is replaced.
        temporary = self.fence + '.pending-' + str(uuid.uuid4())
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump({'trust_epoch': self.args.epoch, 'durability_seq': seq}, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
        self.fault('crash_after_fence_file_fsync')
        os.replace(temporary, self.fence)
        sync_directory(os.path.dirname(self.fence))
        self.fault('crash_after_fence_commit')

    def fault(self, boundary):
        # Fault injection requires explicit helper CLI flags; the production
        # TypeScript adapter never forwards these flags or reads an env switch.
        if self.args.test_fault != boundary or self.current_command != self.args.test_fault_on:
            return
        if boundary.startswith('crash_'):
            os._exit(97)
        raise OSError(errno.ENOSPC, 'synthetic disk full')

    def mutate(self, callback):
        self.check()
        prior_fence = self.fence_value()
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result = callback()
            self.db.execute('UPDATE meta SET durability_seq=durability_seq+1 WHERE singleton=1')
            seq = self.db.execute('SELECT durability_seq FROM meta WHERE singleton=1').fetchone()[0]
            self.fault('disk_full_before_commit')
            self.fault('crash_before_db_commit')
            if self.fence_value() != prior_fence:
                raise ValueError()
            current = os.stat(self.lock_path, follow_symlinks=False)
            if (current.st_ino, current.st_dev) != (self.lock_stat.st_ino, self.lock_stat.st_dev):
                raise ValueError()
            self.db.execute('COMMIT')
        except Exception:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise
        self.fault('crash_after_db_commit')
        self.fault('disk_full_before_fence')
        if self.fence_value() != prior_fence:
            raise ValueError()
        self.write_fence(seq)
        return result

    @staticmethod
    def resolution(db, operation_id):
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resolutions'").fetchone():
            return None
        return db.execute('SELECT * FROM resolutions WHERE operation_id=?', (operation_id,)).fetchone()

    @staticmethod
    def status_row(row, resolution=None):
        if row is None:
            return None
        outcome, action = row['outcome'], row['action']
        active = True if outcome == 'known_success' else False if outcome == 'not_attempted' else None
        unknown = outcome == 'unknown_write'
        return {'operation_id': row['operation_id'], 'action': action, 'outcome': outcome, 'reason': row['reason'],
                'applied': active if action == 'cxone.apply' else False, 'restored': active if action == 'cxone.restore' else False,
                'audit_recorded': None if row['audit_recorded'] is None else bool(row['audit_recorded']),
                'requires_reconciliation': unknown and resolution is None, 'reconciliation': 'resolved' if resolution else 'required' if unknown else 'none',
                'evidence_effect': 'hold' if outcome == 'pending' else 'preserve' if outcome == 'not_attempted' and row['reason'] not in ('stale_preview', 'target_mismatch') else 'invalidate',
                'updated_at': resolution['resolved_at'] if resolution else row['updated_at']}

    @staticmethod
    def report(db):
        meta = dict(db.execute('SELECT trust_epoch,durability_seq FROM meta WHERE singleton=1').fetchone())
        operations = []
        for row in db.execute('SELECT * FROM claims ORDER BY created_at,operation_id'):
            operation = Ledger.status_row(row, Ledger.resolution(db, row['operation_id']))
            operation.update({key: row[key] for key in ('issuer', 'jti', 'binding_sha256', 'subject', 'expires_at', 'snapshot_path', 'cxone_revision_id', 'created_at')})
            operation['target'] = {'hostname': row['hostname'], 'page_id': row['page_id']}
            operations.append(operation)
        return {**meta, 'operations': operations}

    def offline_resolve(self, decision, report_bytes):
        # This method is deliberately absent from the writer's line protocol.
        required = {'operation_id', 'target', 'trust_epoch', 'expected_seq', 'expected_state',
                    'expected_outcome', 'expected_updated_at', 'report_sha256', 'operator', 'reason',
                    'external_settlement_acknowledged', 'writer_drained'}
        if set(decision) != required or decision['writer_drained'] is not True or decision['external_settlement_acknowledged'] is not True:
            raise ValueError()
        if any(type(decision[key]) is not str or not decision[key].strip() or len(decision[key]) > 4096
               for key in required - {'target', 'expected_seq', 'external_settlement_acknowledged', 'writer_drained'}):
            raise ValueError()
        if type(decision['expected_seq']) is not int or decision['trust_epoch'] != self.args.epoch:
            raise ValueError()
        if hashlib.sha256(report_bytes).hexdigest() != decision['report_sha256']:
            raise ValueError()
        report = json.loads(report_bytes)
        if report != self.report(self.db) or report['durability_seq'] != decision['expected_seq']:
            raise ValueError()
        row = self.by_id(decision['operation_id'])
        target = {'hostname': row['hostname'], 'page_id': row['page_id']}
        if decision['target'] != target or decision['expected_state'] != row['state'] or decision['expected_outcome'] != row['outcome'] or decision['expected_updated_at'] != row['updated_at']:
            raise ValueError()
        if row['state'] != 'terminal' or row['outcome'] != 'unknown_write' or row['target_active'] != 1 or self.resolution(self.db, row['operation_id']):
            raise ValueError()
        if self.db.execute("SELECT 1 FROM claims WHERE outcome='pending' OR (hostname=? AND page_id=? AND target_active=1 AND operation_id<>?)", (row['hostname'], row['page_id'], row['operation_id'])).fetchone():
            raise ValueError()
        timestamp = now()
        def append():
            self.db.execute("""CREATE TABLE IF NOT EXISTS resolutions (
                operation_id TEXT PRIMARY KEY REFERENCES claims(operation_id), resolved_at TEXT NOT NULL,
                operator TEXT NOT NULL, reason TEXT NOT NULL, report_sha256 TEXT NOT NULL,
                report BLOB NOT NULL, decision TEXT NOT NULL)""")
            self.db.execute('INSERT INTO resolutions VALUES (?,?,?,?,?,?,?)',
                            (row['operation_id'], timestamp, decision['operator'], decision['reason'],
                             decision['report_sha256'], report_bytes, json.dumps(decision, sort_keys=True)))
            # Preserve the original unknown outcome, reason, time and nonce/token forever.
            self.db.execute('UPDATE claims SET target_active=0 WHERE operation_id=?', (row['operation_id'],))
        self.current_command = 'resolve'
        self.mutate(append)
        self.check()
        return self.status_row(row, self.resolution(self.db, row['operation_id']))

    def by_id(self, operation_id):
        row = self.db.execute('SELECT * FROM claims WHERE operation_id=?', (operation_id,)).fetchone()
        if row is None:
            raise Rejected('operation_not_found')
        return row

    def command(self, command, data):
        self.current_command = command
        self.check()
        if command == 'revoke':
            kids = data['kids']
            if type(kids) is not list or any(type(kid) is not str or not kid for kid in kids):
                raise ValueError()
            new_kids = [kid for kid in set(kids) if self.db.execute('SELECT 1 FROM revocations WHERE kid=?', (kid,)).fetchone() is None]
            if new_kids:
                self.mutate(lambda: self.db.executemany('INSERT INTO revocations VALUES (?,?)', [(kid, now()) for kid in new_kids]))
            return None
        if command == 'is_revoked':
            return self.db.execute('SELECT 1 FROM revocations WHERE kid=?', (data['kid'],)).fetchone() is not None
        if command == 'revocations':
            return [row[0] for row in self.db.execute('SELECT kid FROM revocations ORDER BY kid')]
        if command == 'report':
            return self.report(self.db)
        if command == 'status':
            # Same query-only snapshot/fence checks in both profiles. Do not
            # project proof from a row read independently of its trust context.
            return readonly_report(self.args, data)
        if command == 'claim':
            operation_id, timestamp = str(uuid.uuid4()), now()
            action = data['binding']['action']
            binding_digest = hashlib.sha256(json.dumps(data['binding'], sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
            def insert():
                self.db.execute('''INSERT INTO claims (operation_id,issuer,jti,preview_token,hostname,page_id,binding_sha256,subject,expires_at,action,state,outcome,target_active,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,'claimed','pending',1,?,?)''', (operation_id, data['issuer'], data['jti'], data['preview_token'], data['target']['hostname'], data['target']['page_id'], binding_digest, data['subject'], data['expires_at'], action, timestamp, timestamp))
            try:
                self.mutate(insert)
            except sqlite3.IntegrityError:
                raise Rejected('claim_conflict')
            return self.status_row(self.by_id(operation_id))
        if command == 'start':
            row = self.by_id(data['operation_id'])
            if row['outcome'] != 'pending' or row['state'] != 'claimed' or not data.get('snapshot_path'):
                raise Rejected('invalid_transition')
            # The caller saves HTML and metadata first. Flush the referenced file
            # again before making the irreversible dispatch marker durable.
            snapshot = os.path.abspath(data['snapshot_path'])
            fd = os.open(snapshot, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError()
                os.fsync(fd)
            finally:
                os.close(fd)
            sync_directory(os.path.dirname(snapshot))
            self.mutate(lambda: self.db.execute("UPDATE claims SET state='write_started',snapshot_path=?,updated_at=? WHERE operation_id=?", (snapshot, now(), row['operation_id'])))
            return self.status_row(self.by_id(row['operation_id']))
        if command == 'finish':
            row = self.by_id(data['operation_id'])
            outcome = data['outcome']
            if row['outcome'] != 'pending' or outcome not in ('not_attempted', 'known_success', 'unknown_write'):
                raise Rejected('invalid_transition')
            if (outcome == 'not_attempted') != (row['state'] == 'claimed'):
                raise Rejected('invalid_transition')
            reason = data.get('reason', 'pre_dispatch_failure') if outcome == 'not_attempted' else 'write_outcome_unknown' if outcome == 'unknown_write' else None
            if outcome == 'not_attempted' and reason not in ('no_change', 'stale_preview', 'target_mismatch', 'pre_dispatch_failure'):
                raise Rejected('invalid_transition')
            audit = data.get('audit_recorded')
            if outcome == 'known_success' and type(audit) is not bool:
                raise Rejected('invalid_transition')
            if outcome != 'known_success' and audit is not None:
                raise Rejected('invalid_transition')
            self.mutate(lambda: self.db.execute("UPDATE claims SET state='terminal',outcome=?,reason=?,audit_recorded=?,target_active=?,cxone_revision_id=?,updated_at=? WHERE operation_id=?", (outcome, reason, audit, int(outcome == 'unknown_write'), data.get('cxone_revision_id'), now(), row['operation_id'])))
            return self.status_row(self.by_id(row['operation_id']))
        raise ValueError()


def terminal_proof(row, metadata):
    if row['outcome'] not in ('known_success', 'not_attempted'):
        return None
    success = row['outcome'] == 'known_success'
    if (row['state'] != 'terminal' or row['target_active'] != 0
            or row['action'] not in ('cxone.apply', 'cxone.restore')
            or not re.fullmatch(r'[0-9a-f]{64}', row['binding_sha256'])
            or not row['issuer'] or not row['jti'] or not row['hostname']
            or not re.fullmatch(r'[1-9][0-9]*', row['page_id'])
            or (success and (row['reason'] is not None or row['audit_recorded'] not in (0, 1)))
            or (not success and (row['audit_recorded'] is not None or row['reason'] not in
                                 ('no_change', 'stale_preview', 'target_mismatch', 'pre_dispatch_failure')))):
        raise ValueError()
    return {'contract': 'cxone-terminal-v1',
            **{key: row[key] for key in ('issuer', 'jti', 'operation_id', 'action', 'binding_sha256', 'outcome', 'reason', 'state')},
            'target': {'hostname': row['hostname'], 'page_id': row['page_id']},
            'audit_recorded': bool(row['audit_recorded']) if success else None,
            'terminal_updated_at': row['updated_at'], **metadata}


def readonly_report(args, query=None):
    """Take a consistent local evidence snapshot without opening the writer.

    WAL readers may perform SQLite's transient shared-memory coordination; the
    database, WAL, fence and all claim/recovery state remain unchanged.
    """
    directory = os.path.realpath(args.directory)
    fence = os.path.join(os.path.realpath(os.path.dirname(args.fence)), os.path.basename(args.fence))
    db_path = os.path.join(directory, 'claims.sqlite3')
    if os.path.commonpath([directory, fence]) == directory or os.path.islink(db_path):
        raise ValueError()
    before = Ledger.read_fence(fence)
    if before['trust_epoch'] != args.epoch:
        raise ValueError()
    # mode=ro refuses missing storage instead of creating or repairing it.
    db = sqlite3.connect(Path(db_path).as_uri() + '?mode=ro', uri=True, isolation_level=None, timeout=0)
    try:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        if query is None:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError()
            result = Ledger.report(db)
        else:
            row = db.execute('SELECT * FROM claims WHERE issuer=? AND jti=?', (query['issuer'], query['jti'])).fetchone()
            result = Ledger.status_row(row, Ledger.resolution(db, row['operation_id']) if row else None)
        metadata = dict(db.execute('SELECT trust_epoch,durability_seq FROM meta WHERE singleton=1').fetchone())
        after = Ledger.read_fence(fence)
        if (before != after or metadata != before or type(metadata['durability_seq']) is not int
                or not 0 <= metadata['durability_seq'] <= 9007199254740991):
            raise ValueError()
        if query is not None and result is not None:
            result['terminal_proof'] = terminal_proof(row, metadata)
        return result
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--fence', required=True)
    parser.add_argument('--epoch', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--initialize', action='store_true')
    mode.add_argument('--readonly-report', action='store_true')
    mode.add_argument('--readonly-serve', action='store_true')
    mode.add_argument('--offline-resolve', metavar='DECISION_JSON')
    parser.add_argument('--report-file')
    parser.add_argument('--owner-fd', type=int)
    parser.add_argument('--test-fault', choices=['crash_before_db_commit', 'crash_after_db_commit', 'crash_after_fence_file_fsync', 'crash_after_fence_commit', 'disk_full_before_commit', 'disk_full_before_fence'])
    parser.add_argument('--test-fault-on', choices=['claim', 'start', 'finish', 'revoke', 'resolve'], default='claim')
    args = parser.parse_args()
    os.umask(0o077)
    if args.readonly_serve:
        try:
            readonly_report(args, {'issuer': '', 'jti': ''})
        except Exception:
            emit({'ready': False})
            return 1
        emit({'ready': True})
        while True:
            line = sys.stdin.readline(16385)
            if not line:
                return 0
            request_id = None
            try:
                if len(line) > 16384:
                    raise ValueError()
                request = json.loads(line)
                request_id = request['id']
                if request['command'] != 'status':
                    raise ValueError()
                emit({'id': request_id, 'result': readonly_report(args, request['data'])})
            except Exception:
                emit({'id': request_id, 'error': 'claim_store_unavailable'})
                return 1
    if args.readonly_report:
        try:
            emit(readonly_report(args))
        except Exception:
            emit({'error': 'claim_store_unavailable'})
            return 1
        return 0
    try:
        ledger = Ledger(args)
    except Exception:
        emit({'error': 'offline_resolution_refused'} if args.offline_resolve is not None else {'ready': False})
        return 1 if args.offline_resolve is not None else None
    if args.offline_resolve is not None:
        try:
            # Bounded regular, no-follow files; never load credentials or network content.
            def evidence_file(path):
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as handle:
                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                        raise ValueError()
                    value = handle.read(16 * 1024 * 1024 + 1)
                    if len(value) > 16 * 1024 * 1024:
                        raise ValueError()
                    return value
            decision = json.loads(evidence_file(args.offline_resolve))
            emit(ledger.offline_resolve(decision, evidence_file(args.report_file)))
            return 0
        except Exception:
            emit({'error': 'offline_resolution_refused'})
            return 1
    emit({'ready': True})
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request['id']
            result = ledger.command(request['command'], request.get('data', {}))
            emit({'id': request_id, 'result': result})
        except Rejected as error:
            emit({'id': request_id, 'error': str(error)})
        except Exception:
            emit({'id': request_id, 'error': 'claim_store_unavailable'})
            break


if __name__ == '__main__':
    sys.exit(main())
