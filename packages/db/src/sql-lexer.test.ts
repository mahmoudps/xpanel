import { describe, expect, it } from 'vitest'
import { lexSql, splitStatements, stripComments } from './sql-lexer.ts'

describe('sql lexer', () => {
  it('keeps comment markers that sit inside literals', () => {
    const sql = `SELECT '-- not a comment', "a--b", $$ /* body */ $$; -- real`
    expect(stripComments(sql)).toBe(`SELECT '-- not a comment', "a--b", $$ /* body */ $$;  `)
  })

  it('handles doubled quotes, E-strings and nested block comments', () => {
    expect(stripComments(`SELECT 'it''s'`)).toBe(`SELECT 'it''s'`)
    expect(stripComments(`SELECT E'a\\'b -- c'`)).toBe(`SELECT E'a\\'b -- c'`)
    expect(stripComments('/* a /* b */ c */SELECT 1')).toBe(' SELECT 1')
    // a backslash is literal in a standard string
    expect(lexSql(`SELECT 'a\\' , 1`).map((s) => s.kind)).toEqual(['code', 'string', 'code'])
  })

  it('matches tagged dollar quotes and ignores $n and identifiers with $', () => {
    const segs = lexSql('SELECT $fn$ a $$ b $fn$, $1, x$y$ FROM t')
    expect(segs.filter((s) => s.kind === 'dollar').map((s) => s.text)).toEqual(['$fn$ a $$ b $fn$'])
  })

  it('splits statements outside literals only', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;
      INSERT INTO t VALUES ('a;b'); -- c;d
      ;  SELECT 2`
    expect(splitStatements(sql)).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql',
      "INSERT INTO t VALUES ('a;b')",
      'SELECT 2',
    ])
  })

  it.each([`SELECT 'open`, 'SELECT "open', 'SELECT $$ open', '/* open'])('throws on unterminated %s', (sql) => {
    expect(() => lexSql(sql)).toThrow(/unterminated/)
  })
})
