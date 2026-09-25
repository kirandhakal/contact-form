(() => {
  const byId = (id) => document.getElementById(id);
  let editingForm = null;
  let tenantList = [];

  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.detail || body.title || "Request failed");
    return body;
  };

  const message = (text, bad = false) => {
    const element = byId("notice");
    element.textContent = text;
    element.className = `notice${bad ? " bad" : ""}`;
    element.hidden = false;
    clearTimeout(message.timer);
    message.timer = setTimeout(() => { element.hidden = true; }, 3800);
  };

  function schemaFields(schema) {
    const required = new Set(schema.required || []);
    return Object.entries(schema.properties || {}).map(([name, definition]) => {
      let type = definition.type || "string";
      let options = definition.enum || [];
      if (definition.format === "email") type = "email";
      if (definition.format === "date") type = "date";
      if (definition.enum) type = "select";
      if (definition.type === "array" && definition.items?.enum) { type = "multiselect"; options = definition.items.enum; }
      return { name, type, options, required: required.has(name) };
    });
  }

  function resetBuilder() {
    editingForm = null;
    byId("builder-title").textContent = "Create a form";
    byId("save-form").textContent = "Create form & endpoint";
    byId("template-field").hidden = false;
    byId("create-result").replaceChildren();
    document.getElementById("create-form").reset();
    applyTemplate("contact");
  }

  window.editForm = (form) => {
    editingForm = form;
    byId("builder-title").textContent = "Edit form";
    byId("save-form").textContent = "Save form changes";
    byId("template-field").hidden = true;
    const editor = byId("create-form");
    editor.elements.name.value = form.name;
    editor.elements.successMessage.value = form.successMessage;
    editor.elements.origins.value = form.allowedOrigins.join("\n");
    byId("field-list").replaceChildren();
    schemaFields(form.schema).forEach(addField);
    if (!Object.keys(form.schema.properties || {}).length) addField();
    updatePreview();
    showView("create");
  };

  window.loadForms = async () => {
    if (!me) return;
    try {
      const data = await request("/v1/admin/forms/summary");
      forms = data.forms;
      byId("total-forms").textContent = forms.length;
      byId("total-responses").textContent = forms.reduce((sum, form) => sum + form.acceptedCount, 0);
      byId("total-spam").textContent = forms.reduce((sum, form) => sum + form.spamCount, 0);
      const area = byId("forms");
      area.replaceChildren();
      forms.forEach((form) => {
        const card = document.createElement("article");
        card.className = "card form-card";
        const details = document.createElement("div");
        details.innerHTML = `<div class="form-name"></div><div class="meta"><span><i class="dot${form.status === "active" ? "" : " off"}"></i>${form.status}</span><span>${form.submissionCount} responses</span><span>${form.allowedOrigins.length} allowed origins</span>${me.role !== "tenant" ? `<span>${form.tenantName}</span>` : ""}</div>`;
        details.querySelector(".form-name").textContent = form.name;
        const actions = document.createElement("div");
        actions.className = "actions";
        const edit = document.createElement("button");
        edit.className = "button secondary small";
        edit.textContent = "Edit";
        edit.onclick = () => window.editForm(form);
        const responses = document.createElement("button");
        responses.className = "button secondary small";
        responses.textContent = "Responses & API";
        responses.onclick = () => openResponses(form);
        actions.append(edit, responses);
        card.append(details, actions);
        area.append(card);
      });
      if (!forms.length) area.innerHTML = '<div class="card empty"><strong>No forms yet.</strong><br>Create your first schema and API endpoint.</div>';
    } catch (error) { message(error.message, true); }
  };

  window.renderResponses = (items) => {
    const area = byId("responses");
    area.replaceChildren();
    items.forEach((entry) => {
      const item = document.createElement("article");
      item.className = "response";
      const head = document.createElement("div");
      head.className = "response-head";
      const time = document.createElement("strong");
      time.textContent = new Date(entry.createdAt).toLocaleString();
      const actions = document.createElement("div");
      actions.className = "response-actions";
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = entry.status;
      actions.append(badge);
      if (me.role === "sudo") {
        const edit = document.createElement("button");
        edit.className = "button secondary small";
        edit.textContent = "Edit";
        edit.onclick = async () => {
          const payload = prompt("Edit submission JSON", JSON.stringify(entry.payload, null, 2));
          if (payload === null) return;
          const status = prompt("Status: accepted, spam, or deleted", entry.status);
          if (status === null) return;
          try {
            await request(`/v1/admin/submissions/${entry.id}`, { method: "PATCH", body: JSON.stringify({ payload: JSON.parse(payload), status }) });
            message("Submission updated.");
            await openResponses(selectedForm);
          } catch (error) { message(error.message, true); }
        };
        actions.append(edit);
      }
      head.append(time, actions);
      const payload = document.createElement("pre");
      payload.className = "payload";
      payload.textContent = JSON.stringify(entry.payload, null, 2);
      item.append(head, payload);
      area.append(item);
    });
    if (!items.length) area.innerHTML = '<div class="empty"><strong>No responses yet.</strong></div>';
  };

  async function loadTenants() {
    if (me.role === "tenant") return;
    const data = await request("/v1/admin/tenants");
    tenantList = data.tenants;
    const select = byId("tenant-select");
    select.replaceChildren(...tenantList.map((tenant) => new Option(tenant.name, tenant.id)));
    const area = byId("tenants");
    area.replaceChildren();
    tenantList.forEach((tenant) => {
      const card = document.createElement("form");
      card.className = "card tenant-card";
      card.innerHTML = `<h3></h3><p class="quota">${tenant.formCount}/${tenant.maxForms} forms · ${tenant.totalSubmissions}/${tenant.maxTotalSubmissions} total · ${tenant.dailySubmissions}/${tenant.maxDailySubmissions} today</p><div class="limits"><label>Origins / form<input name="maxOriginsPerForm" type="number" min="1" value="${tenant.maxOriginsPerForm}"></label><label>Total forms<input name="maxForms" type="number" min="1" value="${tenant.maxForms}"></label><label>Total submissions<input name="maxTotalSubmissions" type="number" min="1" value="${tenant.maxTotalSubmissions}"></label><label>Daily submissions<input name="maxDailySubmissions" type="number" min="1" value="${tenant.maxDailySubmissions}"></label></div><button class="button small" style="margin-top:12px">Save permissions</button>`;
      card.querySelector("h3").textContent = tenant.name;
      card.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(card);
        const limits = Object.fromEntries(["maxOriginsPerForm", "maxForms", "maxTotalSubmissions", "maxDailySubmissions"].map((key) => [key, Number(data.get(key))]));
        try { await request(`/v1/admin/tenants/${tenant.id}`, { method: "PATCH", body: JSON.stringify(limits) }); message("Tenant permissions updated."); await loadTenants(); }
        catch (error) { message(error.message, true); }
      };
      area.append(card);
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest('[data-view="create"]');
    if (button && !editingForm) resetBuilder();
    if (event.target.closest('[data-view="forms"]')) editingForm = null;
    if (event.target.closest('[data-view="management"]')) loadTenants().catch((error) => message(error.message, true));
  });

  byId("create-form").onsubmit = async (event) => {
    event.preventDefault();
    const fields = [...document.querySelectorAll(".field-name")].map((input) => input.value.trim()).filter(Boolean);
    if (!fields.length || new Set(fields).size !== fields.length) return message("Add unique field names.", true);
    const data = new FormData(event.currentTarget);
    const payload = { tenantName: "Managed tenant", tenantId: me.role === "tenant" ? undefined : data.get("tenantId"), name: String(data.get("name")).trim(), successMessage: String(data.get("successMessage")).trim(), allowedOrigins: String(data.get("origins")).split(/\s+/).filter(Boolean), schema: buildSchema() };
    try {
      if (editingForm) {
        delete payload.tenantName; delete payload.tenantId;
        await request(`/v1/admin/forms/${encodeURIComponent(editingForm.publicKey)}`, { method: "PATCH", body: JSON.stringify(payload) });
        message("Form updated successfully.");
      } else {
        await request("/v1/admin/forms", { method: "POST", body: JSON.stringify(payload) });
        message("Form created successfully.");
      }
      editingForm = null;
      await loadForms();
      showView("forms");
    } catch (error) { message(error.message, true); }
  };

  byId("password-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try { await request("/v1/admin/password", { method: "POST", body: JSON.stringify(Object.fromEntries(data)) }); event.currentTarget.reset(); message("Password changed."); }
    catch (error) { message(error.message, true); }
  };

  byId("account-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { await request("/v1/admin/users", { method: "POST", body: JSON.stringify(data) }); event.currentTarget.reset(); message("Account created."); await loadTenants(); }
    catch (error) { message(error.message, true); }
  };

  byId("login").onsubmit = async (event) => {
    event.preventDefault();
    byId("login-error").textContent = "";
    const data = new FormData(event.currentTarget);
    try {
      await request("/v1/admin/login", { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
      event.currentTarget.reset();
      await bootRoles();
    } catch (error) { byId("login-error").textContent = error.message; }
  };

  async function bootRoles() {
    try {
      me = await request("/v1/admin/me");
      byId("login-view").hidden = true;
      byId("app-view").hidden = false;
      byId("account-email").textContent = me.email;
      byId("account-role").textContent = `${me.role[0].toUpperCase()}${me.role.slice(1)} admin`;
      byId("management-nav").hidden = me.role === "tenant";
      byId("tenant-field").hidden = me.role === "tenant";
      byId("account-form").hidden = me.role !== "sudo";
      await Promise.all([loadForms(), me.role === "tenant" ? Promise.resolve() : loadTenants()]);
    } catch { byId("login-view").hidden = false; byId("app-view").hidden = true; }
  }

  bootRoles();
})();
