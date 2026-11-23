"""Local credential detectors. No credentials are stored in this module."""
import re,math,collections
KNOWN=[r'\b(?:gsk_|fw_|nvapi-|pplx-|xai-|SG\.)[A-Za-z0-9_.-]{16,}\b',r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',r'\b[a-fA-F0-9]{32,}\b',r'\bapikey_[A-Za-z0-9_]{12,}\b',r'\b(?:sk|pk)[-_](?:live[_-]|test[_-]|proj[_-])?[A-Za-z0-9_-]{16,}\b',r'\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b',r'\bhf_[A-Za-z0-9]{16,}\b',r'\bAKIA[A-Z0-9]{16}\b',r'\bAIza[A-Za-z0-9_-]{30,}\b',r'\bxox[baprs]-[A-Za-z0-9-]{16,}\b',r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b']
LABEL=r'(?:[A-Za-z0-9]+[_.-])*(?:api[\s_-]*key|api[\s_-]*token|apikey|credential|client[\s_-]*secret|secret[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|password|passwd|authorization)'
ASSIGN=re.compile(r'(?i)\b'+LABEL+r'[\"\'`]?\s*(?::|=|\bis\b)\s*[\"\'`]?(?:Bearer\s+)?(?P<value>[^\s\"\'`<>;,\}\]\[]{8,})')
BEARER=re.compile(r'(?i)\bBearer\s+(?P<value>[A-Za-z0-9._~+/-]{8,}=*)')
PLACEHOLDER=re.compile(r'^(?:\[.*\]|\$.*|(?:your|example|placeholder|redacted|none|null|undefined|secret|token|api_key)(?:[_-].*)?)$',re.I)
def spans(text):
 found=[]
 for pattern in KNOWN:
  for m in re.finditer(pattern,text):found.append(dict(start=m.start(),end=m.end(),label='CREDENTIAL',confidence=1.,source='known_credential_rule'))
 for pattern in [ASSIGN,BEARER]:
  for m in pattern.finditer(text):
   value=m.group('value')
   if not PLACEHOLDER.match(value):found.append(dict(start=m.start('value'),end=m.end('value'),label='CREDENTIAL',confidence=1.,source='labelled_credential_rule'))
 # Catch opaque unlabelled strings that strongly resemble secrets; acceptable over-redaction.
 for m in re.finditer(r'(?<![A-Za-z0-9_])[A-Za-z0-9_+/-]{24,}={0,2}(?![A-Za-z0-9_])',text):
  value=m.group();ct=collections.Counter(value);entropy=-sum((n/len(value))*math.log2(n/len(value)) for n in ct.values())
  if sum(c.isupper() for c in value)>=3 and sum(c.islower() for c in value)>=3 and sum(c.isdigit() for c in value)>=3 and entropy>=3.6:
   found.append(dict(start=m.start(),end=m.end(),label='OPAQUE_SECRET',confidence=1.,source='opaque_credential_rule'))
 return list({(s['start'],s['end']):s for s in found}.values())
