/* eslint-disable @typescript-eslint/quotes */

// Import 3rd party modules
import test from 'ava'

// Import module to be tested
import { splitIncludeSourceMap } from '../src/index'

test('should include original positions', t => {
    const sql = [
      "delimiter $$",
      "SELECT * FROM table1$$",
      "delimiter ;;",
      "SELECT t.id FROM table2 t WHERE status = 'pending';;",
      "DELIMITER ;",
      "UPDATE table2 SET count=count+1 WHERE status = 'pending';"
    ].join('\n')
    const output = splitIncludeSourceMap(sql)
    t.is(output.length, 3)
    t.is(output[0].stmt, 'SELECT * FROM table1')
    t.is(output[1].stmt, "SELECT t.id FROM table2 t WHERE status = 'pending'")
    t.is(output[2].stmt, "UPDATE table2 SET count=count+1 WHERE status = 'pending'")
    for (const {stmt, start, end} of output) {
      t.true(sql.substring(start, end).includes(stmt))
    }
  })
  