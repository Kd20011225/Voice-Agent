import { formatTimestamp } from './02-infrastructure-layer.js';

export const LICENSE_PLATE_PATTERN = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}$/u;

export function createVisitorService(infrastructure) {
  function parseVisitInfo(sentence) {
    const result = { visitor_name: '', license_plate: '', company: '', phone: '', reason: '' };
    const text = normalizeChineseDigits(sanitizeTranscript(sentence));

    const phoneMatch = text.match(/1\d{10}/);
    if (phoneMatch) result.phone = phoneMatch[0];
    if (!result.phone) result.phone = parseSpokenPhone(text);

    const plateMatch = text.toUpperCase().match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}/u);
    if (plateMatch) result.license_plate = plateMatch[0].trim();

    const nameMatch = text.match(/(?:我姓|姓|我是|叫)([\u4e00-\u9fa5]{1,4})(?:先生|女士|师傅|老板|经理)?/u)
      || text.match(/([\u4e00-\u9fa5]{1,3})(?:先生|女士|师傅|老板|经理)/u);
    if (nameMatch) result.visitor_name = normalizeVisitorName(nameMatch[1], text);

    const commonReasons = ['送材料', '送货', '拜访', '面试', '维修', '取货', '开会', '安装'];
    for (const reason of commonReasons) {
      if (text.includes(reason)) {
        result.reason = reason;
        break;
      }
    }

    const companyMatch = text.match(/[去到来找]([^，。,. ]{2,20}?)(送材料|送货|拜访|面试|维修|取货|开会|安装|的|$)/);
    if (companyMatch) {
      let company = sanitizeTextField(companyMatch[1])
        .replace(/^(公司|单位)/, '')
        .replace(/手机号.*$/, '')
        .replace(/[的地]$/, '')
        .trim();
      for (const reason of commonReasons) company = company.replace(reason, '').trim();
      result.company = company;
    }

    return result;
  }

  function mergeVisitor(base, patch) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(patch || {})) {
      const cleanValue = sanitizeTextField(value);
      if (cleanValue) merged[key] = cleanValue;
    }
    return merged;
  }

  function normalizeVisitor(visitor) {
    const record = {
      visitor_name: sanitizeTextField(visitor.visitor_name || visitor.name || ''),
      license_plate: normalizeLicensePlate(visitor.license_plate || ''),
      company: sanitizeTextField(visitor.company || ''),
      phone: normalizePhone(visitor.phone || ''),
      reason: sanitizeTextField(visitor.reason || ''),
      visited_at: new Date().toISOString(),
      is_returning: false,
      previous_summary: ''
    };

    const previous = findPreviousVisitor(record);
    if (previous) {
      record.is_returning = true;
      record.previous_summary = `上次于 ${formatTimestamp(previous.visited_at)} 来访 ${previous.company}，事由：${previous.reason}`;
      if (!record.visitor_name && previous.visitor_name) record.visitor_name = previous.visitor_name;
    }
    return record;
  }

  function validateVisitor(visitor) {
    const issues = [];
    if (!visitor.license_plate) {
      issues.push({ field: 'license_plate', reason: 'missing' });
    } else if (!LICENSE_PLATE_PATTERN.test(visitor.license_plate)) {
      issues.push({ field: 'license_plate', reason: 'invalid_format', value: visitor.license_plate });
    }

    if (!visitor.company) issues.push({ field: 'company', reason: 'missing' });
    if (!visitor.reason) issues.push({ field: 'reason', reason: 'missing' });

    if (!visitor.phone) {
      issues.push({ field: 'phone', reason: 'missing' });
    } else if (!/^1\d{10}$/.test(visitor.phone)) {
      issues.push({ field: 'phone', reason: 'invalid_format', value: visitor.phone });
    }

    return issues;
  }

  function findPreviousVisitor(visitor) {
    const phone = normalizePhone(visitor.phone || '');
    const licensePlate = normalizeLicensePlate(visitor.license_plate || '');
    const history = infrastructure.loadVisitors();
    return history.visitors.find((item) => {
      if (!isUsableVisitorRecord(item)) return false;
      const samePhone = phone && normalizePhone(item.phone) === phone;
      const samePlate = licensePlate && normalizeLicensePlate(item.license_plate) === licensePlate;
      return samePhone || samePlate;
    });
  }

  async function completeVisit(visitor) {
    const final = normalizeVisitor(visitor);
    const issues = validateVisitor(final);
    if (issues.length > 0) return { ok: false, issues, visitor: final };

    await infrastructure.saveVisit(final);
    await infrastructure.notifyGuard(final);
    return { ok: true, visitor: final };
  }

  async function recordRiskEvent(event) {
    await infrastructure.saveRiskEvent({
      phone: normalizePhone(event.phone || ''),
      transcript: sanitizeTranscript(event.transcript || ''),
      risk_type: event.risk_type || 'unknown',
      risk_level: event.risk_level || 'low',
      action: event.action || 'log',
      created_at: new Date().toISOString()
    });
  }

  function answerGuardQuery(question) {
    const cleanQuestion = sanitizeTranscript(question);
    if (!cleanQuestion) {
      return {
        answer: '想查哪段访客记录？',
        data: null
      };
    }

    const filters = extractQueryFilters(cleanQuestion, infrastructure);
    if (!hasGuardQueryIntent(cleanQuestion, filters)) {
      return {
        answer: '您说下要查今天、本周，还是某个人的记录。',
        data: { type: 'clarify', filters: publicFilters(filters) }
      };
    }

    const visitors = infrastructure.queryVisitors({ ...filters, limit: 5000 });

    if (/(高峰|最多|时间段|时段)/u.test(cleanQuestion)) {
      return answerPeakHour(cleanQuestion, visitors, filters);
    }

    if (/(最近|上次|最后一次|最新)/u.test(cleanQuestion)) {
      return answerLatestVisit(cleanQuestion, visitors, filters);
    }

    if (/(多少|几辆|几次|总共|一共|数量|统计)/u.test(cleanQuestion)) {
      return answerCount(cleanQuestion, visitors, filters);
    }

    return answerRecentList(cleanQuestion, visitors, filters);
  }

  return {
    parseVisitInfo,
    mergeVisitor,
    normalizeVisitor,
    validateVisitor,
    findPreviousVisitor,
    completeVisit,
    recordRiskEvent,
    answerGuardQuery,
    normalizePhone,
    sanitizeTranscript,
    detectRisk,
    isReturnConfirmation,
    isReturnRejection,
    hasNewVisitDetails
  };
}

function extractQueryFilters(question, infrastructure) {
  const text = normalizeChineseDigits(question).toUpperCase();
  const range = inferDateRange(text);
  const phoneMatch = text.match(/1\d{10}/);
  const plateMatch = text.match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}/u);
  const company = inferCompany(text, infrastructure.listCompanies ? infrastructure.listCompanies() : []);
  const visitorName = inferVisitorName(text, infrastructure.listVisitorNames ? infrastructure.listVisitorNames() : []);

  return {
    startIso: range.startIso,
    endIso: range.endIso,
    rangeLabel: range.label,
    phone: phoneMatch ? phoneMatch[0] : '',
    licensePlate: plateMatch ? plateMatch[0] : '',
    company,
    visitorName
  };
}

function inferDateRange(text) {
  const now = new Date();
  let start;
  let end;
  let label = '全部记录';

  if (/(今天|今日)/u.test(text)) {
    start = startOfDay(now);
    end = addDays(start, 1);
    label = '今天';
  } else if (/(昨天|昨日)/u.test(text)) {
    end = startOfDay(now);
    start = addDays(end, -1);
    label = '昨天';
  } else if (/(本周|这周|本星期|这个星期|周一到现在)/u.test(text)) {
    start = startOfWeekMonday(now);
    end = addDays(start, 7);
    label = '本周';
  } else if (/(上周|上星期)/u.test(text)) {
    end = startOfWeekMonday(now);
    start = addDays(end, -7);
    label = '上周';
  } else if (/(本月|这个月)/u.test(text)) {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    label = '本月';
  } else if (/(上月|上个月)/u.test(text)) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
    label = '上月';
  }

  return {
    startIso: start ? start.toISOString() : '',
    endIso: end ? end.toISOString() : '',
    label
  };
}

function inferCompany(text, companies) {
  const normalizedCompanies = companies
    .map((company) => sanitizeTextField(company))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return normalizedCompanies.find((company) => text.includes(company.toUpperCase())) || '';
}

function inferVisitorName(text, names) {
  const normalizedNames = names
    .map((name) => sanitizeTextField(name))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const exact = normalizedNames.find((name) => text.includes(name.toUpperCase()));
  if (exact) return exact;

  const titleMatch = text.match(/([\u4e00-\u9fa5]{1,3})(?:先生|女士|师傅|老板|经理)/u);
  if (titleMatch) return titleMatch[0];

  const surnameMatch = text.match(/(?:姓|姓氏是)([\u4e00-\u9fa5])/u);
  if (surnameMatch) {
    const surname = surnameMatch[1];
    return normalizedNames.find((name) => name.startsWith(surname)) || surname;
  }

  return '';
}

function hasGuardQueryIntent(question, filters) {
  if (filters.startIso || filters.endIso || filters.phone || filters.licensePlate || filters.company || filters.visitorName) {
    return true;
  }
  return /(访问|访客|来访|车辆|车|记录|登记|多少|几辆|几次|总共|一共|数量|统计|高峰|最多|时间段|时段|最近|上次|最后一次|最新|今天|昨天|本周|这周|上周|本月|这个月|上月)/u.test(question);
}

function answerCount(question, visitors, filters) {
  const subject = describeQuerySubject(filters);
  const label = `${filters.rangeLabel}${subject}`.trim();
  const uniquePlates = new Set(visitors.map((item) => item.license_plate).filter(Boolean)).size;
  const answer = visitors.length === 0
    ? `${label}没有匹配的访问记录。`
    : `${label}共有 ${visitors.length} 次访问，涉及 ${uniquePlates} 辆车。`;
  return {
    answer,
    data: {
      type: 'count',
      visits: visitors.length,
      uniqueVehicles: uniquePlates,
      filters: publicFilters(filters)
    }
  };
}

function answerPeakHour(question, visitors, filters) {
  if (visitors.length === 0) {
    return {
      answer: `${filters.rangeLabel}没有匹配的访问记录，暂时看不出高峰时段。`,
      data: { type: 'peak_hour', buckets: [], filters: publicFilters(filters) }
    };
  }

  const buckets = new Map();
  for (const visitor of visitors) {
    const hour = new Date(visitor.visited_at).getHours();
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }

  const ranked = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hour, count]) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00`,
      count
    }));

  const top = ranked[0];
  return {
    answer: `${filters.rangeLabel}访问最多的时间段是 ${top.label}，共有 ${top.count} 次访问。`,
    data: {
      type: 'peak_hour',
      top,
      buckets: ranked.slice(0, 6),
      filters: publicFilters(filters)
    }
  };
}

function answerLatestVisit(question, visitors, filters) {
  const latest = visitors[0];
  if (!latest) {
    return {
      answer: `${filters.rangeLabel}没有找到匹配的访问记录。`,
      data: { type: 'latest', latest: null, filters: publicFilters(filters) }
    };
  }

  const name = latest.visitor_name ? `${latest.visitor_name}，` : '';
  return {
    answer: `最近一次是 ${formatTimestamp(latest.visited_at)}，${name}车牌 ${latest.license_plate}，来 ${latest.company}${latest.reason}。`,
    data: {
      type: 'latest',
      latest,
      filters: publicFilters(filters)
    }
  };
}

function answerRecentList(question, visitors, filters) {
  const recent = visitors.slice(0, 5);
  if (recent.length === 0) {
    return {
      answer: `${filters.rangeLabel}没有找到匹配的访问记录。`,
      data: { type: 'recent_list', visitors: [], filters: publicFilters(filters) }
    };
  }

  const lines = recent.map((item) => {
    const name = item.visitor_name ? `${item.visitor_name} ` : '';
    return `${formatTimestamp(item.visited_at)} ${name}${item.license_plate} 来 ${item.company}${item.reason}`;
  });
  return {
    answer: `${filters.rangeLabel}最近 ${recent.length} 条记录：${lines.join('；')}。`,
    data: {
      type: 'recent_list',
      visitors: recent,
      filters: publicFilters(filters)
    }
  };
}

function describeQuerySubject(filters) {
  if (filters.visitorName) return `${filters.visitorName} `;
  if (filters.licensePlate) return `车牌 ${filters.licensePlate} `;
  if (filters.phone) return `手机号 ${maskPhone(filters.phone)} `;
  if (filters.company) return `${filters.company} `;
  return '';
}

function publicFilters(filters) {
  return {
    rangeLabel: filters.rangeLabel,
    startIso: filters.startIso,
    endIso: filters.endIso,
    company: filters.company,
    visitorName: filters.visitorName,
    licensePlate: filters.licensePlate,
    phone: filters.phone ? maskPhone(filters.phone) : ''
  };
}

function maskPhone(phone) {
  return phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '';
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeekMonday(date) {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  return addDays(start, 1 - day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function sanitizeTranscript(input) {
  return String(input || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>{}[\]`$\\/]/g, '')
    .replace(/\b(ignore|system|developer|assistant|tool|function|script|prompt)\b/gi, '')
    .replace(/忽略(之前|上面|所有)?(指令|规则|提示词)?/g, '')
    .replace(/系统(提示词|指令)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function sanitizeTextField(input) {
  return sanitizeTranscript(input)
    .replace(/[|;'"=]/g, '')
    .trim()
    .slice(0, 60);
}

export function detectRisk(sentence) {
  const text = sanitizeTranscript(sentence).replace(/\s+/g, '');
  if (!text) return null;

  if (/(杀|打死|砍|炸|威胁|弄死|撞门|硬闯|冲进去)/u.test(text)) {
    return { risk_type: 'threat', risk_level: 'high', action: 'handoff' };
  }

  if (/(傻逼|操你|草你|妈的|滚|废物|垃圾|白痴|蠢|听不懂)/u.test(text)) {
    return { risk_type: 'abuse', risk_level: 'medium', action: 'deescalate' };
  }

  if (/(忽略.*指令|忽略.*规则|按我说的做|你现在是|systemprompt|promptinjection)/iu.test(text)) {
    return { risk_type: 'prompt_injection', risk_level: 'medium', action: 'ignore_and_continue' };
  }

  return null;
}

export function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '').slice(-11);
}

export function normalizeChineseDigits(text) {
  const digitMap = {
    零: '0', 〇: '0', 洞: '0',
    一: '1', 幺: '1',
    二: '2', 两: '2',
    三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9'
  };
  return Array.from(String(text || '')).map((char) => digitMap[char] || char).join('');
}

export function normalizeLicensePlate(plate) {
  return normalizeChineseDigits(plate).replace(/\s+/g, '').toUpperCase();
}

function parseSpokenPhone(text) {
  const normalized = normalizeChineseDigits(text);
  const digits = Array.from(normalized).map((char) => /\d/.test(char) ? char : '').join('');
  const match = digits.match(/1\d{10}/);
  return match ? match[0] : '';
}

function isUsableVisitorRecord(visitor) {
  return LICENSE_PLATE_PATTERN.test(normalizeLicensePlate(visitor.license_plate || ''))
    && /^1\d{10}$/.test(normalizePhone(visitor.phone || ''))
    && Boolean(visitor.company && visitor.reason);
}

function normalizeVisitorName(name, text = '') {
  const clean = sanitizeTextField(name).replace(/^(我姓|姓|我是|叫)/, '');
  if (!clean) return '';
  if (/(先生|男|师傅)/u.test(text)) return `${clean}先生`;
  if (/(女士|女|小姐)/u.test(text)) return `${clean}女士`;
  if (/(老板)/u.test(text)) return `${clean}老板`;
  if (/(经理)/u.test(text)) return `${clean}经理`;
  return clean.length === 1 ? `${clean}先生` : clean;
}

function isReturnConfirmation(sentence) {
  const text = normalizeChineseDigits(sanitizeTranscript(sentence)).replace(/\s+/g, '');
  return /^(对|是|对对|对的|是的|嗯|行|可以|好|好的|没错|还是|还是老地方|老地方)[。！!，,]*$/u.test(text)
    || /^(对|是|嗯|好).*(老地方|一样|还是|没变)/u.test(text);
}

function isReturnRejection(sentence) {
  const text = sanitizeTranscript(sentence).replace(/\s+/g, '');
  return /(不是|不对|换|改|今天去|这次去|重新)/u.test(text);
}

function hasNewVisitDetails(parsed, sentence) {
  const text = normalizeChineseDigits(sanitizeTranscript(sentence)).toUpperCase();
  return Boolean(parsed.visitor_name || parsed.license_plate || parsed.company || parsed.reason || parsed.phone)
    || LICENSE_PLATE_PATTERN.test(text)
    || /1\d{10}/.test(text);
}
