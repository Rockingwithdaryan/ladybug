// Unknown API paths answer in JSON like every other API error, instead of with the HTML 404 page.
const notFound = async () => Response.json({ error: "Not found" }, { status: 404 });

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
