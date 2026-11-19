// Public titles are independent of the authoritative source labels.
const titles = {
  P1: '“Too Many Migrants”',
  P2: 'High Housing Prices',
  P3: 'Ongoing Skills Shortages',
  P4: 'Infrastructure Costs Too Much',
  P5: 'Cost of Living Too High',
  P6: 'Loss of Social Cohesion',
  L1: 'Land Value Inflation'
};

export const publicLabel = node => titles[node.id] ?? `${node.label.trimEnd().replace(/\.+$/, '')}.`;

const loopTitles = {
  F1: 'Rising land prices fuel speculation.',
  F2: 'Workers leave for smaller firms.',
  F3: 'Lost skills weaken big businesses.',
  F4: 'Blaming other groups fuels more blame.',
  'F5-A': 'Higher prices push up wage costs.',
  'F5-B': 'Higher prices drive staff turnover.'
};

export const publicLoopLabel = loop => loopTitles[loop.id] ?? loop.name;

// Public qualifications exclude source-register instructions and graph construction notes.
// A null entry means the source qualification contains only internal guidance.
const edgeQualifications = {
  'H1|F1B': null,
  'I4|T12': null,
  'M4|C1': null,
  'L1|F1A': 'This connection does not imply that land inflation occurs later than housing investment demand.',
  'T4|T12': 'Lower productivity in large firms and competition from smaller firms are separate pressures on profit margins.',
  'M5|U4': 'High infrastructure costs per dwelling contribute directly to development costs.',
  'U9|U5': 'Sparse networks burden maintenance costs per household.',
  'E6|T5': 'Land-linked premises overheads can contribute to consumer prices, conditional on costs being passed through.',
  'Q12|Q5': 'Converting community facilities to commercial use can increase competition for a limited pool of customers.',
  'Q20|Q14': 'This applies only to housing-driven departures, not to all adult children moving away.',
  'Q26|Q24': 'Existing beliefs make blame messages politically rewarding; these messages reinforce beliefs.',
  'C1|C2': 'Pressure to minimise construction labour expenditure is an effect of squeezed construction margins.',
  'C2|M5': 'Higher land-related development costs can squeeze construction margins, without necessarily raising physical build quantities or unit material costs.',
  'C2|C3': 'Constrained cost pass-through to price-sensitive housing purchasers and occupants can squeeze construction margins; these pressures can operate jointly or separately.',
  'T5|X1': 'Employers may offer additional remuneration to retain workers seeking better-paid jobs; incremental retention wage cost contributes to overheads.',
  'T5|X2': 'Departed workers requiring replacement can raise recruitment and onboarding costs, including temporary coverage and productivity disruption.',
  'X2|X4': 'Departure and staff replacement are conditional on actual turnover and a need to recruit.',
  'X4|X3': 'This is a general response of looking for another job or leaving a job, distinct from the selective departure of capable employees from large firms.',
  'X3|P5': 'High living costs motivate seeking better-paid employment; no universal wage increase or departure is implied.'
};

export const publicEdgeQualification = (id, sourceText) => Object.hasOwn(edgeQualifications, id) ? edgeQualifications[id] : sourceText;
