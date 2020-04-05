const SINGLE_QUOTE = "'"
const DOUBLE_QUOTE = '"'
const BACKTICK = '`'
const DOUBLE_DASH_COMMENT_START = '--'
const HASH_COMMENT_START = '#'
const C_STYLE_COMMENT_START = '/*'
const SEMICOLON = ';'
const DELIMITER_KEYWORD = 'DELIMITER'

export interface SplitOptions {
  multipleStatements?: boolean
}

interface SplitExecutionContext {
  multipleStatements: boolean
  unread: string
  currentDelimiter: string
  currentStatement: string
  splitResult: string[]
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
const delimiterTokenRegex = /(?:'(.+)'|"(.+)"|`(.+)`|([^\s]+))/
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

function read (context: SplitExecutionContext, readToIndex: number, nextUnreadIndex?: number): void {
  context.currentStatement += context.unread.slice(0, readToIndex)
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

function publishStatement (context: SplitExecutionContext): void {
  const currentStatement = context.currentStatement.trim()
  if (currentStatement !== '') {
    if (!context.multipleStatements) {
      context.splitResult.push(currentStatement)
    } else {
      if (context.currentDelimiter === SEMICOLON) {
        if (context.splitResult.length === 0) {
          context.splitResult.push('')
        }
        context.splitResult[context.splitResult.length - 1] += currentStatement + SEMICOLON + '\n'
      } else {
        context.splitResult.push(currentStatement)
      }
    }
  }
  context.currentStatement = ''
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
      read(context, findQuoteResult.nextIndex)
      break
    }
    case DOUBLE_DASH_COMMENT_START: {
      read(context, findResult.expIndex, findResult.expIndex + DOUBLE_DASH_COMMENT_START.length)
      const findCommentResult = findExp(context.unread, newLineRegex)
      discard(context, findCommentResult.expIndex)
      break
    }
    case HASH_COMMENT_START: {
      read(context, findResult.expIndex, findResult.nextIndex)
      const findCommentResult = findExp(context.unread, newLineRegex)
      discard(context, findCommentResult.expIndex)
      break
    }
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
      const matched = context.unread.match(delimiterTokenRegex)
      if (matched?.index !== undefined) {
        context.currentDelimiter = matched[0].trim()
        discard(context, matched[0].length)
      }
      const findNewLineResult = findExp(context.unread, newLineRegex)
      discard(context, findNewLineResult.expIndex)
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
    currentStatement: '',
    splitResult: []
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
  return context.splitResult
}
