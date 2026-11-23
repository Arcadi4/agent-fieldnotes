"""Recognize harness envelopes at the start of a captured user message."""
import json
import re


def leading_tag(text, tag):
    return re.match(rf'<{tag}(?:\s[^>]*|)>(.*?)</{tag}>\s*', text, re.S)


def human_prompt(app, body):
    text = body.strip()
    while text:
        context_tags = {
            'codex': ('in-app-browser-context',),
            'cursor': ('timestamp', 'system_notification'),
            'claude': ('local-command-caveat',),
        }.get(app, ())
        wrapper = next((match for tag in context_tags if (match := leading_tag(text, tag))), None)
        if not wrapper:
            break
        text = text[wrapper.end():].strip()

    generated = {
        'codex': ('heartbeat', 'realtime_delegation', 'codex_delegation'),
        'claude': ('side-sessions-event', 'cross-session-message', 'ci-monitor-event',
                   'local-command-stdout', 'local-command-stderr'),
    }
    if any(leading_tag(text, tag) for tag in generated.get(app, ())):
        return '', 'harness event'

    if app == 'claude':
        command = leading_tag(text, 'command-message')
        content = text[command.end():] if command else text
        name = leading_tag(content, 'command-name')
        if name:
            args = leading_tag(content[name.end():], 'command-args')
            suffix = args[1].strip() if args else ''
            command_text = '/' + name[1].strip().lstrip('/')
            return ' '.join(x for x in (command_text, suffix) if x), 'typed command'
        shell = leading_tag(text, 'bash-input')
        if shell:
            return '! ' + shell[1].strip(), 'typed shell command'

    if app == 'codex' and (reply := leading_tag(text, 'send_user_message_question_reply')):
        try:
            items = json.loads(reply[1])
            answers = [item['answer'].strip() for item in items
                       if isinstance(item, dict) and isinstance(item.get('answer'), str)]
            return '\n'.join(filter(None, answers)), 'user reply'
        except (ValueError, TypeError):
            return '', 'unreadable reply envelope'

    return text, 'metadata wrapper' if text != body.strip() else None
