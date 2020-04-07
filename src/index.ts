const SINGLE_QUOTE = "'"
const DOUBLE_QUOTE = '"'
const BACKTICK = '`'
const DOUBLE_DASH_COMMENT_START = '--'
const HASH_COMMENT_START = '#'
const C_STYLE_COMMENT_START = '/*'
const SEMICOLON = ';'
const LINE_FEED = '\n'
const DELIMITER_KEYWORD = 'DELIMITER'

export interface SplitOptions {
  multipleStatements?: boolean
}

interface SqlStatement {
  statement: string
  allowMultiStatement: boolean
}

interface SplitExecutionContext {
  multipleStatements: boolean
  unread: string
  currentDelimiter: string
  currentStatement: SqlStatement
  output: SqlStatement[]
}

interface FindExpResult {
  expIndex: number
  exp: string | null
  nextIndex: number
}

const regexEscapeSetRegex = /[-/\\^$*+?.()|[\]{}]/g
const singleQuoteStringEndRegex = /(?<!\\)'/
const doubleQuoteStringEndRegex = /(?<!\\)"/
const backtickQuoteEndRegex = /(?<!`)`(?!`)/
const doubleDashCommentStartRegex = /--[ \f\n\r\t\v]/
const cStyleCommentStartRegex = /\/\*/
const cStyleCommentEndRegex = /(?<!\/)\*\//
const newLineRegex = /(?:[\r\n]+|$)/
const delimiterStartRegex = /(?:^|[\n\r]+)[ \f\t\v]*DELIMITER[ \t]+/i
// Best effort only, unable to find a syntax specification on delimiter
const delimiterTokenRegex = /^(?:'(.+)'|"(.+)"|`(.+)`|([^\s]+))/
const semicolonKeyTokenRegex = buildKeyTokenRegex(SEMICOLON)
const quoteEndRegexDict: Record<string, RegExp> = {
  [SINGLE_QUOTE]: singleQuoteStringEndRegex,
  [DOUBLE_QUOTE]: doubleQuoteStringEndRegex,
  [BACKTICK]: backtickQuoteEndRegex
}

function escapeRegex (value: string): string {
  return value.replace(regexEscapeSetRegex, '\\$&')
}

function buildKeyTokenRegex (delimiter: string): RegExp {
  return new RegExp('(?:' + [
    escapeRegex(delimiter),
    SINGLE_QUOTE,
    DOUBLE_QUOTE,
    BACKTICK,
    doubleDashCommentStartRegex.source,
    HASH_COMMENT_START,
    cStyleCommentStartRegex.source,
    delimiterStartRegex.source
  ].join('|') + ')', 'i')
}

function findExp (content: string, regex: RegExp): FindExpResult {
  const match = content.match(regex)
  let result: FindExpResult
  if (match?.index !== undefined) {
    result = {
      expIndex: match.index,
      exp: match[0],
      nextIndex: match.index + match[0].length
    }
  } else {
    result = {
      expIndex: -1,
      exp: null,
      nextIndex: content.length
    }
  }
  return result
}

function findKeyToken (content: string, currentDelimiter: string): FindExpResult {
  let regex
  if (currentDelimiter === SEMICOLON) {
    regex = semicolonKeyTokenRegex
  } else {
    regex = buildKeyTokenRegex(currentDelimiter)
  }
  return findExp(content, regex)
}

function findEndQuote (content: string, quote: string): FindExpResult {
  if (!(quote in quoteEndRegexDict)) {
    throw new TypeError(`Incorrect quote ${quote} supplied`)
  }
  return findExp(content, quoteEndRegexDict[quote])
}

function read (
  context: SplitExecutionContext,
  readToIndex: number,
  nextUnreadIndex?: number,
  checkSemicolon? : boolean
): void {
  if (checkSemicolon === undefined) {
    checkSemicolon = true
  }
  const readContent = context.unread.slice(0, readToIndex)
  if (checkSemicolon && readContent.includes(SEMICOLON)) {
    context.currentStatement.allowMultiStatement = false
  }
  context.currentStatement.statement += readContent
  if (nextUnreadIndex !== undefined && nextUnreadIndex > 0) {
    context.unread = context.unread.slice(nextUnreadIndex)
  } else {
    context.unread = context.unread.slice(readToIndex)
  }
}

function discard (context: SplitExecutionContext, nextUnreadIndex: number): void {
  if (nextUnreadIndex > 0) {
    context.unread = context.unread.slice(nextUnreadIndex)
  }
}

function discardTillNewLine (context: SplitExecutionContext): void {
  const findResult = findExp(context.unread, newLineRegex)
  discard(context, findResult.expIndex)
}

function publishStatementInMultiMode (splitOutput: SqlStatement[], currentStatement: SqlStatement): void {
  if (splitOutput.length === 0) {
    splitOutput.push({
      statement: '',
      allowMultiStatement: true
    })
  }
  const lastSplitResult = splitOutput[splitOutput.length - 1]
  if (lastSplitResult.allowMultiStatement) {
    if (currentStatement.allowMultiStatement) {
      if (lastSplitResult.statement !== '' && !lastSplitResult.statement.endsWith(LINE_FEED)) {
        lastSplitResult.statement += LINE_FEED
      }
      lastSplitResult.statement += currentStatement.statement + SEMICOLON
    } else {
      splitOutput.push({
        statement: currentStatement.statement,
        allowMultiStatement: false
      })
    }
  } else {
    if (currentStatement.allowMultiStatement) {
      splitOutput.push({
        statement: currentStatement.statement + SEMICOLON,
        allowMultiStatement: true
      })
    } else {
      splitOutput.push({
        statement: currentStatement.statement,
        allowMultiStatement: false
      })
    }
  }
}

function publishStatement (context: SplitExecutionContext): void {
  const trimmed = context.currentStatement.statement.trim()
  if (trimmed !== '') {
    if (!context.multipleStatements) {
      context.output.push({
        statement: trimmed,
        allowMultiStatement: context.currentStatement.allowMultiStatement
      })
    } else {
      context.currentStatement.statement = trimmed
      publishStatementInMultiMode(context.output, context.currentStatement)
    }
  }
  context.currentStatement.statement = ''
  context.currentStatement.allowMultiStatement = true
}

function handleKeyTokenFindResult (context: SplitExecutionContext, findResult: FindExpResult): void {
  switch (findResult.exp?.trim()) {
    case context.currentDelimiter:
      read(context, findResult.expIndex, findResult.nextIndex)
      publishStatement(context)
      break
    case SINGLE_QUOTE:
    case DOUBLE_QUOTE:
    case BACKTICK: {
      read(context, findResult.nextIndex)
      const findQuoteResult = findEndQuote(context.unread, findResult.exp)
      read(context, findQuoteResult.nextIndex, undefined, false)
      break
    }
    case DOUBLE_DASH_COMMENT_START:
      read(context, findResult.expIndex, findResult.expIndex + DOUBLE_DASH_COMMENT_START.length)
      discardTillNewLine(context)
      break
    case HASH_COMMENT_START:
      read(context, findResult.expIndex, findResult.nextIndex)
      discardTillNewLine(context)
      break
    case C_STYLE_COMMENT_START: {
      if (['!', '+'].includes(context.unread[findResult.nextIndex])) {
        // Should not be skipped, see https://dev.mysql.com/doc/refman/5.7/en/comments.html
        read(context, findResult.nextIndex)
        const findCommentResult = findExp(context.unread, cStyleCommentEndRegex)
        read(context, findCommentResult.nextIndex)
      } else {
        read(context, findResult.expIndex, findResult.nextIndex)
        const findCommentResult = findExp(context.unread, cStyleCommentEndRegex)
        discard(context, findCommentResult.nextIndex)
      }
      break
    }
    case DELIMITER_KEYWORD: {
      read(context, findResult.expIndex, findResult.nextIndex)
      // MySQL client will return `DELIMITER cannot contain a backslash character` if backslash is used
      // Shall we reject backslash as well?
      const matched = context.unread.match(delimiterTokenRegex)
      if (matched?.index !== undefined) {
        context.currentDelimiter = matched[0].trim()
        discard(context, matched[0].length)
      }
      discardTillNewLine(context)
      break
    }
    case undefined:
    case null:
      read(context, findResult.nextIndex)
      publishStatement(context)
      break
    default:
      // This should never happen
      throw new Error(`Unknown token '${findResult.exp ?? '(null)'}'`)
  }
}

export function split (sql: string, options?: SplitOptions): string[] {
  options = options ?? {}
  const multipleStatements = options.multipleStatements ?? false

  const context: SplitExecutionContext = {
    multipleStatements,
    unread: sql,
    currentDelimiter: SEMICOLON,
    currentStatement: {
      statement: '',
      allowMultiStatement: true
    },
    output: []
  }
  let findResult: FindExpResult = {
    expIndex: -1,
    exp: null,
    nextIndex: 0
  }
  let lastUnreadLength
  do {
    lastUnreadLength = context.unread.length
    findResult = findKeyToken(context.unread, context.currentDelimiter)
    handleKeyTokenFindResult(context, findResult)
    // Prevent infinite loop by returning incorrect result
    if (lastUnreadLength === context.unread.length) {
      read(context, context.unread.length)
    }
  } while (context.unread !== '')
  publishStatement(context)
  return context.output.map(v => v.statement)
}
