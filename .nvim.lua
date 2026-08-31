local source_filetypes = {
	"javascript",
	"javascriptreact",
	"typescript",
	"typescriptreact",
}

vim.api.nvim_create_autocmd("FileType", {
	group = vim.api.nvim_create_augroup("codework", { clear = true }),
	pattern = source_filetypes,
	callback = function(event)
		vim.bo[event.buf].expandtab = false
		vim.bo[event.buf].shiftwidth = 3
		vim.bo[event.buf].softtabstop = 3
		vim.bo[event.buf].tabstop = 3

		local conform = require("conform")
		conform.formatters_by_ft[vim.bo[event.buf].filetype] = { "oxfmt" }
	end,
})
