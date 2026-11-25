(function () {
  "use strict";

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const START_HOUR = 8; // 08:00
  const END_HOUR = 18;  // 18:00
  const THEME_KEY = "tt_builder_theme";
  const SESSION_TOKEN_KEY = "tt_access_token";
  const SESSION_USER_KEY = "tt_auth_user";

  const state = {
    token: sessionStorage.getItem(SESSION_TOKEN_KEY) || "",
    user: null,
    generatedOptions: [],
    currentIndex: 0,
    activeSections: [],
    activeLabel: ""
  };

  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const userLabel = document.getElementById("user-label");
  const signInLink = document.getElementById("sign-in-link");
  const signOutBtn = document.getElementById("sign-out-btn");
  const authBanner = document.getElementById("auth-banner");

  const courseListEl = document.getElementById("course-list");
  const generateBtn = document.getElementById("generate-btn");

  const alertBox = document.getElementById("alert-box");
  const prevBtn = document.getElementById("prev-option-btn");
  const nextBtn = document.getElementById("next-option-btn");
  const optionCounter = document.getElementById("option-counter");

  const saveForm = document.getElementById("save-form");
  const timetableNameInput = document.getElementById("timetable-name");
  const saveTimetableBtn = document.getElementById("save-timetable-btn");

  const gridMeta = document.getElementById("grid-meta");
  const timetableGrid = document.getElementById("timetable-grid");

  const refreshSavedBtn = document.getElementById("refresh-saved-btn");
  const savedListEl = document.getElementById("saved-list");

  function init() {
    initTheme();
    renderEmptyGrid();

    themeToggleBtn.addEventListener("click", toggleTheme);
    signOutBtn.addEventListener("click", handleSignOut);
    generateBtn.addEventListener("click", handleGenerate);
    prevBtn.addEventListener("click", () => switchOption(-1));
    nextBtn.addEventListener("click", () => switchOption(1));
    saveForm.addEventListener("submit", handleSaveTimetable);
    refreshSavedBtn.addEventListener("click", loadSavedTimetables);

    bootstrapLiveMode();
  }

  function readCachedUser() {
    try {
      const raw = sessionStorage.getItem(SESSION_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveSessionCache(token, user) {
    if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    else sessionStorage.removeItem(SESSION_TOKEN_KEY);

    if (user) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(SESSION_USER_KEY);
  }

  function syncAdminNav(user) {
    const nav = document.querySelector(".topbar-nav");
    if (!nav) return;
    nav.querySelectorAll("[data-admin-link]").forEach((el) => el.remove());
    if (user && user.role === "admin") {
      const importsLink = document.createElement("a");
      importsLink.href = "/imports.html";
      importsLink.textContent = "Imports";
      importsLink.setAttribute("data-admin-link", "1");

      const accountsLink = document.createElement("a");
      accountsLink.href = "/admin.html";
      accountsLink.textContent = "Accounts";
      accountsLink.setAttribute("data-admin-link", "1");

      nav.append(importsLink, accountsLink);
    }
  }

  function setSignedOutUI() {
    state.token = "";
    state.user = null;
    saveSessionCache("", null);
    localStorage.removeItem("tt_builder_jwt");
    syncAdminNav(null);
    userLabel.textContent = "";
    userLabel.classList.add("hidden");
    signOutBtn.classList.add("hidden");
    signInLink.classList.remove("hidden");
    authBanner.classList.remove("hidden");
    generateBtn.disabled = true;
    refreshSavedBtn.disabled = true;
    courseListEl.replaceChildren(createParagraph("muted", "Sign in to select courses."));
    savedListEl.replaceChildren(createParagraph("muted", "Sign in to load saved timetables."));
  }

  function setSignedInUI(user) {
    state.user = user || null;
    authBanner.classList.add("hidden");
    signInLink.classList.add("hidden");
    signOutBtn.classList.remove("hidden");
    userLabel.textContent = (user && (user.email || user.name)) || "Signed in";
    userLabel.classList.remove("hidden");
    generateBtn.disabled = false;
    refreshSavedBtn.disabled = false;
    syncAdminNav(state.user);
  }

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (_) {}
    setSignedOutUI();
    window.location.assign("/");
  }

  async function refreshAccessToken() {
    const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    if (!r.ok) return "";
    const b = await r.json();
    const token = b && typeof b.accessToken === "string" ? b.accessToken.trim() : "";
    if (!token) return "";
    state.token = token;
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    return token;
  }

  async function bootstrapLiveMode() {
    localStorage.removeItem("tt_builder_jwt");
    try {
      let cachedUser = readCachedUser();
      if (state.token && cachedUser) {
        setSignedInUI(cachedUser);
      } else {
        if (!state.token) {
          const token = await refreshAccessToken();
          if (!token) {
            setSignedOutUI();
            return;
          }
        }
        const meRes = await fetch("/api/auth/me", {
          headers: { Authorization: "Bearer " + state.token }
        });
        if (!meRes.ok) {
          setSignedOutUI();
          return;
        }
        const meData = await meRes.json();
        cachedUser = (meData && (meData.user || meData)) || null;
        saveSessionCache(state.token, cachedUser);
        setSignedInUI(cachedUser);
      }
    } catch (_) {
      setSignedOutUI();
      return;
    }

    await loadLiveCourses();
    await loadSavedTimetables();
  }

  async function loadLiveCourses() {
    try {
      const r = await apiFetch("/api/courses");
      if (!r.ok || !r.data) return;
      const items = Array.isArray(r.data) ? r.data : (r.data.items || r.data.courses || r.data.data || []);
      if (items.length) {
        window.APP_CONFIG.MOCK_COURSES = items.map((c) => ({
          id: String(c.id),
          label: (c.code ? c.code + " - " : "") + (c.title || c.name || c.id),
          note: c.credits != null ? c.credits + " credits" : ""
        }));
        renderCoursePicker();
      } else {
        courseListEl.replaceChildren(createParagraph("muted", "No courses found in catalogue."));
      }
    } catch (_) {}
  }

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeToggleBtn.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") {
      applyTheme(saved);
      return;
    }
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  async function apiFetch(path, options = {}) {
    if (!state.token) {
      throw new Error("You are not signed in.");
    }
    const headers = Object.assign(
      { Authorization: "Bearer " + state.token },
      options.body ? { "Content-Type": "application/json" } : {},
      options.headers || {}
    );

    let res = await fetch(window.APP_CONFIG.API_BASE_URL + path, {
      method: options.method || "GET",
      headers,
      body: options.body
    });

    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        res = await fetch(window.APP_CONFIG.API_BASE_URL + path, {
          method: options.method || "GET",
          headers: Object.assign({}, headers, { Authorization: "Bearer " + refreshed }),
          body: options.body
        });
      } else {
        setSignedOutUI();
      }
    }

    if (options.rawResponse) {
      if (!res.ok) {
        const text = await res.text();
        throw new Error("Request failed (" + res.status + "): " + text);
      }
      return res;
    }

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  function showAlert(type, title, lines) {
    alertBox.className = "alert alert-" + type;
    alertBox.replaceChildren();

    const titleEl = document.createElement("div");
    titleEl.className = "alert-title";
    titleEl.textContent = title;
    alertBox.appendChild(titleEl);

    if (Array.isArray(lines) && lines.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "alert-list";
      lines.forEach((line) => {
        const li = document.createElement("li");
        li.textContent = String(line);
        ul.appendChild(li);
      });
      alertBox.appendChild(ul);
    }
  }

  function clearAlert() {
    alertBox.className = "alert hidden";
    alertBox.replaceChildren();
  }

  function createParagraph(className, text) {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  function renderCoursePicker() {
    courseListEl.replaceChildren();
    window.APP_CONFIG.MOCK_COURSES.forEach((course, idx) => {
      const label = document.createElement("label");
      label.className = "course-item";

      const left = document.createElement("span");
      left.className = "course-left";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = course.id;
      checkbox.name = "courseId";
      if (idx < 3) checkbox.checked = true;

      const text = document.createElement("span");
      text.textContent = course.label;

      left.appendChild(checkbox);
      left.appendChild(text);

      const note = document.createElement("span");
      note.className = "course-note";
      note.textContent = course.note;

      label.appendChild(left);
      label.appendChild(note);
      courseListEl.appendChild(label);
    });
  }

  function getSelectedCourseIds() {
    const checked = courseListEl.querySelectorAll('input[name="courseId"]:checked');
    return Array.from(checked).map((el) => el.value);
  }

  async function handleGenerate() {
    clearAlert();
    const courseIds = getSelectedCourseIds();
    if (courseIds.length === 0) {
      showAlert("warn", "No Courses Selected", ["Pick at least one course before generating."]);
      return;
    }

    generateBtn.disabled = true;
    try {
      const res = await apiFetch("/api/timetables/generate", {
        method: "POST",
        body: JSON.stringify({ courseIds })
      });

      if (res.status === 422) {
        const err = (res.data && res.data.error) || {};
        const details = [];
        if (err.message) details.push(err.message);
        if (Array.isArray(err.conflictingCourseIds) && err.conflictingCourseIds.length) {
          details.push("Conflicting courses: " + err.conflictingCourseIds.join(", "));
        }
        if (Array.isArray(err.conflictingPairs) && err.conflictingPairs.length) {
          const pairs = err.conflictingPairs.map((pair) =>
            Array.isArray(pair) ? pair.join(" vs ") : JSON.stringify(pair)
          );
          details.push("Conflicting pairs: " + pairs.join("; "));
        }
        state.generatedOptions = [];
        state.activeSections = [];
        updateSwitcherUI();
        renderEmptyGrid();
        showAlert("error", "422 No Valid Timetable (" + (err.code || "CONFLICT") + ")", details);
        return;
      }

      if (!res.ok) {
        const msg = (res.data && res.data.error && res.data.error.message) || ("HTTP " + res.status);
        showAlert("error", "Generation Failed", [msg]);
        return;
      }

      const timetables = (res.data && res.data.timetables) || [];
      if (timetables.length === 0) {
        showAlert("warn", "Empty Result", ["No timetables were returned for the selected courses."]);
        return;
      }

      state.generatedOptions = timetables;
      state.currentIndex = 0;
      displayGeneratedOption(0);

      if (res.data && res.data.capped) {
        showAlert("warn", "Results Capped", ["Showing the maximum capped number of clash-free combinations."]);
      }
    } catch (err) {
      showAlert("error", "Request Error", [err.message]);
    } finally {
      generateBtn.disabled = false;
    }
  }

  function extractSections(option) {
    if (Array.isArray(option)) return option;
    if (option && Array.isArray(option.sections)) return option.sections;
    return [];
  }

  function displayGeneratedOption(index) {
    state.currentIndex = index;
    state.activeSections = extractSections(state.generatedOptions[index]);
    state.activeLabel = "Generated Option " + (index + 1) + " of " + state.generatedOptions.length;
    updateSwitcherUI();
    renderTimetableGrid(state.activeSections, state.activeLabel);
  }

  function switchOption(delta) {
    const next = state.currentIndex + delta;
    if (next >= 0 && next < state.generatedOptions.length) {
      displayGeneratedOption(next);
    }
  }

  function updateSwitcherUI() {
    const total = state.generatedOptions.length;
    if (total === 0) {
      optionCounter.textContent = state.activeLabel || "No timetable loaded";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    } else {
      optionCounter.textContent = "Option " + (state.currentIndex + 1) + " of " + total;
      prevBtn.disabled = state.currentIndex <= 0;
      nextBtn.disabled = state.currentIndex >= total - 1;
    }
    saveTimetableBtn.disabled = state.activeSections.length === 0;
  }

  async function handleSaveTimetable(event) {
    event.preventDefault();
    clearAlert();

    const name = timetableNameInput.value.trim();
    const sectionIds = state.activeSections
      .map((sec) => sec.sectionId || sec.id)
      .filter(Boolean);

    if (!name || sectionIds.length === 0) {
      showAlert("warn", "Cannot Save", ["Generate a timetable and enter a name first."]);
      return;
    }

    saveTimetableBtn.disabled = true;
    try {
      const res = await apiFetch("/api/timetables", {
        method: "POST",
        body: JSON.stringify({ name, sectionIds })
      });

      if (!res.ok) {
        const msg = (res.data && res.data.error && res.data.error.message) || ("HTTP " + res.status);
        showAlert("error", "Save Failed", [msg]);
        return;
      }

      timetableNameInput.value = "";
      showAlert("success", "Timetable Saved", ['Saved "' + name + '" with ' + sectionIds.length + " sections."]);
      await loadSavedTimetables();
    } catch (err) {
      showAlert("error", "Save Error", [err.message]);
    } finally {
      saveTimetableBtn.disabled = state.activeSections.length === 0;
    }
  }

  async function loadSavedTimetables() {
    try {
      const res = await apiFetch("/api/timetables");
      if (!res.ok) {
        const msg = (res.data && res.data.error && res.data.error.message) || ("HTTP " + res.status);
        savedListEl.replaceChildren(createParagraph("muted", "Failed to load: " + msg));
        return;
      }

      const items = Array.isArray(res.data) ? res.data : (res.data && res.data.timetables) || [];
      savedListEl.replaceChildren();

      if (items.length === 0) {
        savedListEl.appendChild(createParagraph("muted", "No saved timetables yet."));
        return;
      }

      items.forEach((item) => {
        const id = item.id || item.timetableId;
        const card = document.createElement("div");
        card.className = "saved-item";

        const top = document.createElement("div");
        top.className = "saved-item-top";

        const nameEl = document.createElement("span");
        nameEl.className = "saved-name";
        nameEl.textContent = item.name || ("Timetable " + id);
        top.appendChild(nameEl);

        if (item.stale) {
          const staleBadge = document.createElement("span");
          staleBadge.className = "badge badge-danger";
          staleBadge.textContent = "Stale";
          top.appendChild(staleBadge);
        }

        const actions = document.createElement("div");
        actions.className = "saved-actions";

        const viewBtn = document.createElement("button");
        viewBtn.type = "button";
        viewBtn.className = "btn btn-ghost btn-sm";
        viewBtn.textContent = "View";
        viewBtn.addEventListener("click", () => handleViewSaved(id));

        const icsBtn = document.createElement("button");
        icsBtn.type = "button";
        icsBtn.className = "btn btn-ghost btn-sm";
        icsBtn.textContent = "Download .ics";
        icsBtn.addEventListener("click", () => handleDownloadIcs(id, item.name));

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-danger btn-sm";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => handleDeleteSaved(id));

        actions.appendChild(viewBtn);
        actions.appendChild(icsBtn);
        actions.appendChild(delBtn);

        card.appendChild(top);
        card.appendChild(actions);
        savedListEl.appendChild(card);
      });
    } catch (err) {
      savedListEl.replaceChildren(createParagraph("muted", err.message));
    }
  }

  async function handleViewSaved(id) {
    clearAlert();
    try {
      const res = await apiFetch("/api/timetables/" + encodeURIComponent(id));
      if (!res.ok) {
        showAlert("error", "Load Failed", ["Could not load timetable (" + res.status + ")."]);
        return;
      }

      const tt = res.data || {};
      state.generatedOptions = [];
      state.activeSections = Array.isArray(tt.sections) ? tt.sections : [];
      state.activeLabel = "Saved: " + (tt.name || id);
      updateSwitcherUI();
      renderTimetableGrid(state.activeSections, state.activeLabel);

      const warnings = [];
      if (tt.stale) {
        warnings.push("One or more sections changed in the catalogue since this timetable was saved.");
      }
      if (Array.isArray(tt.missingSectionIds) && tt.missingSectionIds.length > 0) {
        warnings.push("Missing sections: " + tt.missingSectionIds.join(", "));
      }
      if (warnings.length > 0) {
        showAlert("warn", "Stale Timetable Warning", warnings);
      }
    } catch (err) {
      showAlert("error", "View Error", [err.message]);
    }
  }

  async function handleDownloadIcs(id, name) {
    clearAlert();
    try {
      const res = await apiFetch("/api/timetables/" + encodeURIComponent(id) + "/calendar.ics", {
        rawResponse: true
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const safeName = (name || "timetable").replace(/[^a-z0-9_-]+/gi, "_");

      const link = document.createElement("a");
      link.href = url;
      link.download = safeName + ".ics";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showAlert("error", "Calendar Export Failed", [err.message]);
    }
  }

  async function handleDeleteSaved(id) {
    clearAlert();
    try {
      const res = await apiFetch("/api/timetables/" + encodeURIComponent(id), {
        method: "DELETE"
      });
      if (!res.ok && res.status !== 204) {
        showAlert("error", "Delete Failed", ["HTTP " + res.status]);
        return;
      }
      showAlert("success", "Deleted", ["Timetable removed."]);
      await loadSavedTimetables();
    } catch (err) {
      showAlert("error", "Delete Error", [err.message]);
    }
  }

  function renderEmptyGrid() {
    gridMeta.textContent = "Select courses and click Generate Timetables, or view a saved timetable.";
    buildBaseGrid();
  }

  function buildBaseGrid() {
    timetableGrid.replaceChildren();

    const corner = document.createElement("div");
    corner.className = "grid-header";
    corner.textContent = "Time";
    corner.style.gridColumn = "1";
    corner.style.gridRow = "1";
    timetableGrid.appendChild(corner);

    DAYS.forEach((day, idx) => {
      const header = document.createElement("div");
      header.className = "grid-header";
      header.textContent = day;
      header.style.gridColumn = String(idx + 2);
      header.style.gridRow = "1";
      timetableGrid.appendChild(header);
    });

    const totalRows = (END_HOUR - START_HOUR) * 2;
    for (let r = 0; r < totalRows; r++) {
      const gridRow = r + 2;
      const timeCell = document.createElement("div");
      timeCell.className = "grid-time";
      timeCell.style.gridColumn = "1";
      timeCell.style.gridRow = String(gridRow);

      if (r % 2 === 0) {
        const hour = START_HOUR + r / 2;
        timeCell.textContent = String(hour).padStart(2, "0") + ":00";
      }
      timetableGrid.appendChild(timeCell);

      for (let c = 0; c < DAYS.length; c++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.style.gridColumn = String(c + 2);
        cell.style.gridRow = String(gridRow);
        timetableGrid.appendChild(cell);
      }
    }
  }

  function normalizeDayIndex(rawDay) {
    if (!rawDay) return -1;
    const prefix = String(rawDay).trim().slice(0, 3).toLowerCase();
    return DAYS.findIndex((d) => d.toLowerCase() === prefix);
  }

  function parseTimeToMinutes(value) {
    if (typeof value === "number") {
      return value <= 24 ? value * 60 : value;
    }
    if (typeof value === "string") {
      const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
      if (match) {
        return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
      }
    }
    return null;
  }

  function extractSlotsFromSection(section) {
    if (Array.isArray(section.times)) return section.times;
    if (Array.isArray(section.slots)) return section.slots;
    if (Array.isArray(section.meetings)) return section.meetings;
    if (Array.isArray(section.sessions)) return section.sessions;
    if (Array.isArray(section.days)) {
      return section.days.map((d) => ({
        day: d,
        startTime: section.startTime || section.start,
        endTime: section.endTime || section.end,
        room: section.room || section.location
      }));
    }
    return [section];
  }

  function renderTimetableGrid(sections, label) {
    buildBaseGrid();
    gridMeta.textContent = label + " — " + sections.length + " section(s)";

    const courseColorMap = new Map();
    let nextColor = 0;

    sections.forEach((section) => {
      const courseKey = String(section.courseCode || section.courseId || section.courseName || section.id || "course");
      if (!courseColorMap.has(courseKey)) {
        courseColorMap.set(courseKey, nextColor % 5);
        nextColor += 1;
      }
      const colorIdx = courseColorMap.get(courseKey);
      const slots = extractSlotsFromSection(section);

      slots.forEach((slot) => {
        const dayIdx = normalizeDayIndex(slot.day || slot.dayOfWeek);
        const startMin = parseTimeToMinutes(slot.startTime || slot.start || slot.startMinutes);
        const endMin = parseTimeToMinutes(slot.endTime || slot.end || slot.endMinutes);

        if (dayIdx < 0 || startMin === null || endMin === null) return;

        const baseMin = START_HOUR * 60;
        const startRow = Math.max(2, Math.floor((startMin - baseMin) / 30) + 2);
        const endRow = Math.min(22, Math.ceil((endMin - baseMin) / 30) + 2);
        if (endRow <= startRow) return;

        const courseLabel = section.courseCode || section.courseTitle || section.courseName || ("Course " + (section.courseId || ""));
        const secLabel = section.sectionCode || section.sectionId || section.id || "";
        const headingText = secLabel ? (courseLabel + " (" + secLabel + ")") : courseLabel;
        const timeText = (slot.startTime || slot.start || "") + " - " + (slot.endTime || slot.end || "");
        const room = slot.room || slot.location || section.room || section.location || "";

        const block = document.createElement("div");
        block.className = "slot-block color-" + colorIdx;
        block.style.gridColumn = String(dayIdx + 2);
        block.style.gridRow = startRow + " / " + endRow;
        block.title = [headingText, section.courseTitle, timeText, room].filter(Boolean).join(" | ");

        const title = document.createElement("div");
        title.className = "slot-title";
        title.textContent = headingText;

        const timeLine = document.createElement("div");
        timeLine.className = "slot-sub";
        timeLine.textContent = timeText;

        block.appendChild(title);
        block.appendChild(timeLine);

        if (room) {
          const roomEl = document.createElement("div");
          roomEl.className = "slot-sub";
          roomEl.textContent = room;
          block.appendChild(roomEl);
        }

        timetableGrid.appendChild(block);
      });
    });
  }

  init();
})();
