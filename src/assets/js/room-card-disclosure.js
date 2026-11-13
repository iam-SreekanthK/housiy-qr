/* Shared collapsible-card and participant disclosure behavior.
 * Participants use an icon-only chevron, matching Emoji Reaction History.
 */
(function () {
  'use strict';

  document.querySelectorAll('.collapsible-room-card').forEach(function (card) {
    if (card.matches('[data-room-card="players"]') || card.matches('[data-room-card="reactions"]')) return;
    var toggle = card.querySelector('.room-card-toggle');
    var content = card.querySelector('.room-card-content');
    if (!toggle || !content) return;
    function setOpen(open) {
      toggle.setAttribute('aria-expanded', String(open));
      content.hidden = !open;
      card.classList.toggle('room-card-expanded', open);
    }
    setOpen(toggle.getAttribute('aria-expanded') === 'true');
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
  });

  var card = document.querySelector('[data-room-card="players"]');
  var list = document.getElementById('playersList');
  var toggle = document.getElementById('participantsToggle');
  if (!card || !list || !toggle) return;

  function updateParticipantsDisclosure() {
    var rows = Array.from(list.children).filter(function (el) {
      return !el.matches('.text-dim.small') || !/loading|no players/i.test(el.textContent);
    });
    var count = rows.length;
    var countNode = document.getElementById('participantsCount');
    if (countNode) countNode.textContent = String(count);

    var longList = count > 5;
    var initialized = card.dataset.participantsToggleInitialized === 'true';
    card.classList.toggle('players-list-long', longList);
    toggle.hidden = !longList;

    if (!longList) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Show all participants');
      toggle.title = 'Show all participants';
      list.classList.remove('participants-clamped');
      card.classList.remove('room-card-expanded');
      return;
    }

    if (!initialized) {
      toggle.setAttribute('aria-expanded', 'false');
      card.dataset.participantsToggleInitialized = 'true';
    }
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    list.classList.toggle('participants-clamped', !expanded);
    card.classList.toggle('room-card-expanded', expanded);
    toggle.setAttribute('aria-label', expanded ? 'Collapse participants' : 'Expand participants');
    toggle.title = expanded ? 'Collapse participants' : 'Expand participants';
  }

  toggle.addEventListener('click', function () {
    if (toggle.hidden) return;
    toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
    updateParticipantsDisclosure();
  });
  new MutationObserver(updateParticipantsDisclosure).observe(list, { childList: true, subtree: true });
  updateParticipantsDisclosure();
  setTimeout(updateParticipantsDisclosure, 500);
})();
